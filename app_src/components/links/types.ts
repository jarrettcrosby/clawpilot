export type ShortLinkRecord = {
  id: string
  ownerEmail?: string
  sourceApp?: string
  shortUrl: string
  slug: string
  destinationUrl: string
  title: string
  tags: string[]
  status: string
  expiresAt: string | null
  maxClicks: number | null
  clickCount: number
  remainingClicks: number | null
  createdAt: string
  updatedAt: string
}

export type ShortLinkWriteInput = {
  destinationUrl?: string
  title?: string
  slug?: string
  slugLength?: number
  tags?: string[]
  durationHours?: number | null
  maxClicks?: number | null
}
