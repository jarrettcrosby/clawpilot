import { NextResponse } from 'next/server'

export const CLAWPILOT_PICKING_APP_IDS = [
  'CN2T77JHQQ.com.eigenracing.ios.picking',
  'CN2T77JHQQ.com.eigenracing.ios.picking.dev',
] as const

const association = {
  applinks: {
    apps: [],
    details: [{
      appIDs: [...CLAWPILOT_PICKING_APP_IDS],
      components: [{ '/': '/ios*', comment: 'Meta Wearables registration callback' }],
    }],
  },
}

export function appleAppSiteAssociationResponse() {
  return NextResponse.json(association, {
    headers: {
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
