import axios from "axios"
import { Contract, ethers } from "ethers"
import Redis from "ioredis"

import { GET_ALL_CAMPAIGNS_URL, TRANSFER_EVENT_ABI } from "./constants"
import {
  fromNetworkNameToChainId,
  getBlockExplorerApiUrl,
  parseTransferEvent,
} from "./utils"

import type {
  Campaign,
  CampaignStatus,
  GetTransferLogsResponse,
  ParsedTransferEvent,
  SupportedNetwork,
} from "./types"

export default class Indexer {
  private provider: ethers.providers.AlchemyProvider
  private network: SupportedNetwork
  private redis: Redis
  private blockExplorerApiUrl: string
  private campaigns: Campaign[] = []

  constructor(network: SupportedNetwork, alchemyKey: string, redisUrl?: string) {
    console.log("Creating indexer for", network)

    this.network = network
    this.blockExplorerApiUrl = getBlockExplorerApiUrl(network)
    this.provider = new ethers.providers.AlchemyProvider(network, alchemyKey)

    if (redisUrl) this.redis = new Redis(redisUrl, { tls: { rejectUnauthorized: false } })
    else this.redis = new Redis()
  }

  public async flushRedis() {
    console.log("Flushing Redis cache")
    return await this.redis.flushall()
  }

  public async collectCampaigns() {
    try {
      const campaignsResponse = await axios.get(GET_ALL_CAMPAIGNS_URL)
      const campaigns = campaignsResponse.data.campaigns as Campaign[]

      const campaignsOnCurrentNetwork: Campaign[] = campaigns
        .filter((campaign) =>
          campaign.chainId.includes(fromNetworkNameToChainId(this.network))
        )
        // mapping the object from the API response to custom Campaign type
        .map((cmp) => {
          return {
            title: cmp.title,
            description: cmp.description,
            id: cmp.id,
            chainId: cmp.chainId,
            startTime: cmp.startTime,
            endTime: cmp.endTime,
            status: this.getCampaignStatus(cmp) || "idle",
            network: this.network,
            projectName: cmp.projectName,
            isPrivate: cmp.isPrivate,
            imageUrl: cmp.imageUrl,
            projectId: cmp.projectId,
            address: cmp.address,
          }
        })

      this.campaigns = campaignsOnCurrentNetwork
      console.log("Found", this.campaigns.length, "campaigns on", this.network)

      const campaignsKey = `campaigns:${this.network}`
      const campaignsValues = this.campaigns.map((cmp) => JSON.stringify(cmp))
      await this.redis.del(campaignsKey)
      await this.redis.rpush(campaignsKey, ...campaignsValues)
    } catch (err) {
      console.error("Error while fetching campaigns on ", this.network)
      console.error(err)
      this.campaigns = []
    }
  }

  private getCampaignStatus(campaign: Campaign): CampaignStatus | null {
    if (!campaign) return null

    const now = new Date()
    const startTime = new Date(campaign.startTime)
    const endTime = new Date(campaign.endTime)

    if (now < startTime) return "idle"
    else if (now > endTime) return "ended"
    else return "active"
  }

  private async getBlockNumberByTimestamp(timestamp: number) {
    try {
      const response = await axios.get(
        `${this.blockExplorerApiUrl}&module=block&action=getblocknobytime&timestamp=${timestamp}&closest=before`
      )
      return response.data.result
    } catch (err) {
      console.error("Error while fetching block number by timestamp")
      console.error(err)
    }
  }

  // Note: The explorer API only returns the last 1000 events,
  // so the ideal solution is to query the RPC instead.
  private async queryTransferEventsFromExplorer(
    contract: Contract,
    fromBlock: number,
    toBlock: number | "latest" = "latest"
  ): Promise<ParsedTransferEvent[]> {
    try {
      const apiResponse = await axios.get<GetTransferLogsResponse>(
        `${this.blockExplorerApiUrl}&module=logs&action=getLogs&fromBlock=${fromBlock}&toBlock=${toBlock}&address=${contract.address}&topic1=0x0000000000000000000000000000000000000000000000000000000000000000`
      )

      if (apiResponse.data.message !== "OK")
        throw new Error(`API error: ${apiResponse?.data?.result}`)

      const parsedTransfers = apiResponse.data.result.map(parseTransferEvent)
      return parsedTransfers
    } catch (err) {
      console.error("Error while fetching transfer events from explorer")
      console.error(err)
      return []
    }
  }

  private async queryTransferEventsFromRpc(
    contract: Contract,
    fromBlock: number,
    toBlock?: number
  ): Promise<ParsedTransferEvent[]> {
    console.log("Querying transfers from block", fromBlock)

    try {
      const logs = await this.provider.getLogs({
        ...contract.filters.Transfer(),
        fromBlock,
        toBlock: toBlock || "latest",
      })

      const transfers: ParsedTransferEvent[] = logs.map((log) => {
        const parsedLog = contract.interface.parseLog(log)
        return {
          from: parsedLog.args[0],
          to: parsedLog.args[1],
          tokenId: parsedLog.args[2].toString(),
        } as ParsedTransferEvent
      })

      return transfers
    } catch (err) {
      console.error("Error while fetching transfer events from RPC")
      console.error(err)
      return []
    }
  }

  public async getAllTransfers(campaign: Campaign): Promise<ParsedTransferEvent[]> {
    const campaignStatus = this.getCampaignStatus(campaign)
    if (campaignStatus === "idle") return []

    const campaignContract = new ethers.Contract(
      campaign.address,
      [TRANSFER_EVENT_ABI],
      this.provider
    )

    try {
      const startBlock = await this.getBlockNumberByTimestamp(
        new Date(campaign.startTime).getTime() / 1000
      )

      if (!startBlock)
        throw new Error(`Could not find start block for campaign ${campaign.id}`)

      if (campaignStatus === "ended") {
        const endBlock = await this.getBlockNumberByTimestamp(
          new Date(campaign.endTime).getTime() / 1000
        )

        if (!endBlock)
          throw new Error(`Could not find end block for campaign ${campaign.id}`)

        return await this.queryTransferEventsFromExplorer(
          campaignContract,
          startBlock,
          endBlock
        )
      } else {
        return await this.queryTransferEventsFromExplorer(campaignContract, startBlock)
      }
    } catch (err) {
      console.error("Error while fetching transfers on ", this.network)
      console.error("Campaign title: ", campaign.title)
      console.error(err)
      return []
    }
  }

  private async saveParticipationsToRedis(
    transfers: ParsedTransferEvent[],
    campaign: Campaign
  ) {
    const title = campaign.title
    const network = this.network
    const link = `https://tideprotocol.xyz/users/campaign/${campaign.id}`

    const key = `transfers:${campaign.id}`
    const values = transfers.map((t) => JSON.stringify({ ...t, title, link, network }))
    await this.redis.del(key)
    await this.redis.rpush(key, ...values)

    const key2 = `transfers:length:${campaign.id}`
    await this.redis.set(key2, transfers.length)
  }

  private async getTransfersAmountFromRedis(campaignId: string) {
    const key = `transfers:length:${campaignId}`
    const value = await this.redis.get(key)
    return value ? parseInt(value) : 0
  }

  public async shouldUpdateTransfers(
    campaignId: string,
    eventsFound: number
  ): Promise<boolean> {
    const currentEvents = await this.getTransfersAmountFromRedis(campaignId)
    if (!currentEvents || currentEvents < eventsFound) return true
    else return false
  }

  public async indexCampaign(campaign: Campaign, onlyUpdate: boolean) {
    if (this.getCampaignStatus(campaign) === "idle")
      return console.log(`CID: ${campaign.id} is idle, skipping indexing`)

    const transfers = await this.getAllTransfers(campaign)
    if (!transfers) return console.log(`CID: ${campaign.id} has no transfers`)
    else console.log(`CID: ${campaign.id}: ${transfers.length} transfers found.`)

    if (onlyUpdate) {
      const shouldUpdate = await this.shouldUpdateTransfers(campaign.id, transfers.length)
      if (!shouldUpdate) return console.log(`CID: ${campaign.id} is up to date.`)
    }

    await this.saveParticipationsToRedis(transfers, campaign)
  }

  public async indexAllCampaigns({ onlyUpdate = false } = {}) {
    if (onlyUpdate) console.log("Running in update mode...")

    await this.collectCampaigns()

    for (const campaign of this.campaigns) {
      await this.indexCampaign(campaign, onlyUpdate)
      await new Promise((resolve) => setTimeout(resolve, 1200))
    }

    console.log("Indexing finished for ", this.network)
  }
}
