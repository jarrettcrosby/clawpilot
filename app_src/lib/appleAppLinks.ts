import { NextResponse } from 'next/server'

export const CLAWPILOT_PICKING_APP_ID = 'CN2T77JHQQ.com.eigenracing.ios.picking'

const association = {
  applinks: {
    apps: [],
    details: [{
      appIDs: [CLAWPILOT_PICKING_APP_ID],
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
