'use client'

import { useEffect } from 'react'

export default function LoginPage() {
  useEffect(() => {
    window.location.replace(`/?r=${Date.now()}`)
  }, [])

  return null
}
