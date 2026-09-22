export type ShortLinkRecord = {
  id: string
  ownerEmail?: string
  sourceApp?: string
  shortUrl: string
  publicDomain?: 'eigenracing' | 'bpo'
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

export type ShortLinkDomainChoice = { key: 'eigenracing' | 'bpo'; label: string }

export type ShortLinkWriteInput = {
  publicDomain?: 'eigenracing' | 'bpo'
  destinationUrl?: string
  title?: string
  slug?: string
  slugLength?: number
  tags?: string[]
  durationHours?: number | null
  maxClicks?: number | null
}
