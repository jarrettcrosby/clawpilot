'use client'

import { useMemo } from 'react'
import { Box, Link, Stack, TextField, Typography } from '@mui/material'
import { emailBodyPreview } from '@/lib/crm/emailBodyPreview.mjs'

export default function EmailBodyPreview({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const parts = useMemo(() => emailBodyPreview(value), [value])
  return (
    <Stack gap={1.5} sx={{ minWidth: 0 }}>
      <Box component="section" aria-label="Email message" data-testid="crm-email-preview" sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2, minWidth: 0 }}>
        <Typography variant="subtitle2" sx={{ mb: 1.5 }}>Email message</Typography>
        <Typography component="div" variant="body2" sx={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere', lineHeight: 1.65 }}>
          {parts.length ? parts.map((part, index) => part.href ? (
            <Link key={index} href={part.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" title={part.href} underline="hover">
              {part.text}
            </Link>
          ) : part.text) : 'No message content.'}
        </Typography>
      </Box>
      <Box component="details" sx={{ minWidth: 0, '& > summary': { cursor: 'pointer', color: 'text.secondary', typography: 'body2' } }}>
        <Box component="summary">{disabled ? 'View original content' : 'View or edit original content'}</Box>
        <TextField
          fullWidth
          disabled={disabled}
          label="Description"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          helperText="Original archived content. The preview does not change the saved message."
          multiline
          minRows={4}
          maxRows={14}
          sx={{ mt: 2 }}
        />
      </Box>
    </Stack>
  )
}
