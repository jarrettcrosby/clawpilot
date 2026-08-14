'use client'

import InfoOutlined from '@mui/icons-material/InfoOutlined'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'

type ContextHelpProps = {
  title: string
  label?: string
}

export default function ContextHelp({ title, label = 'More information' }: ContextHelpProps) {
  return (
    <Tooltip
      arrow
      enterTouchDelay={0}
      leaveTouchDelay={6_000}
      title={title}
    >
      <IconButton
        aria-label={label}
        size="small"
        sx={{ color: 'text.secondary', p: 0.25 }}
      >
        <InfoOutlined sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  )
}
