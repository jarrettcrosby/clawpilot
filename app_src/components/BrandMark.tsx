import Box from '@mui/material/Box'
import type { SxProps, Theme } from '@mui/material/styles'

type BrandMarkProps = {
  size?: number | string
  sx?: SxProps<Theme>
}

export default function BrandMark({ size = 36, sx }: BrandMarkProps) {
  return (
    <Box
      component="img"
      src="/brand/clawpilot-mark.svg"
      alt=""
      aria-hidden="true"
      sx={{ width: size, height: size, display: 'block', flexShrink: 0, ...sx }}
    />
  )
}
