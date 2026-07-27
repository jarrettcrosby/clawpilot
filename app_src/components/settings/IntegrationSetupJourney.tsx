'use client'

import { useId, useState, type ReactNode } from 'react'
import Accordion from '@mui/material/Accordion'
import AccordionDetails from '@mui/material/AccordionDetails'
import AccordionSummary from '@mui/material/AccordionSummary'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Stack from '@mui/material/Stack'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import ContentCopyRounded from '@mui/icons-material/ContentCopyRounded'
import ErrorRounded from '@mui/icons-material/ErrorRounded'
import ExpandMoreRounded from '@mui/icons-material/ExpandMoreRounded'
import RadioButtonCheckedRounded from '@mui/icons-material/RadioButtonCheckedRounded'
import RadioButtonUncheckedRounded from '@mui/icons-material/RadioButtonUncheckedRounded'

export type IntegrationSetupStepState =
  | 'complete'
  | 'current'
  | 'attention'
  | 'pending'

export type IntegrationSetupFact = {
  label: string
  value: string
  copyable?: boolean
}

export type IntegrationSetupStep = {
  key: string
  label: string
  description: string
  state: IntegrationSetupStepState
  optional?: boolean
  facts?: IntegrationSetupFact[]
  action?: ReactNode
}

type IntegrationSetupJourneyProps = {
  title?: string
  description: string
  steps: IntegrationSetupStep[]
  defaultExpanded?: boolean
}

const statePresentation: Record<
  IntegrationSetupStepState,
  {
    label: string
    color: 'default' | 'primary' | 'success' | 'warning'
    Icon: typeof CheckCircleRounded
  }
> = {
  complete: {
    label: 'Complete',
    color: 'success',
    Icon: CheckCircleRounded,
  },
  current: {
    label: 'Next',
    color: 'primary',
    Icon: RadioButtonCheckedRounded,
  },
  attention: {
    label: 'Needs attention',
    color: 'warning',
    Icon: ErrorRounded,
  },
  pending: {
    label: 'Pending',
    color: 'default',
    Icon: RadioButtonUncheckedRounded,
  },
}

export default function IntegrationSetupJourney({
  title = 'Setup journey',
  description,
  steps,
  defaultExpanded,
}: IntegrationSetupJourneyProps) {
  const contentId = useId()
  const [copiedFact, setCopiedFact] = useState('')
  const requiredSteps = steps.filter((step) => !step.optional)
  const completedSteps = requiredSteps.filter(
    (step) => step.state === 'complete',
  ).length
  const hasAttention = steps.some((step) => step.state === 'attention')
  const complete = requiredSteps.length > 0
    && completedSteps === requiredSteps.length

  return (
    <Accordion
      disableGutters
      defaultExpanded={defaultExpanded ?? !complete}
      variant="outlined"
      sx={{
        borderRadius: '10px !important',
        '&::before': { display: 'none' },
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreRounded />}
        aria-controls={contentId}
      >
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
          sx={{ width: '100%', pr: 1 }}
        >
          <Box>
            <Typography fontWeight={700}>{title}</Typography>
            <Typography variant="body2" color="text.secondary">
              {description}
            </Typography>
          </Box>
          <Chip
            size="small"
            color={hasAttention ? 'warning' : complete ? 'success' : 'primary'}
            variant={complete ? 'filled' : 'outlined'}
            label={`${completedSteps} of ${requiredSteps.length} complete`}
          />
        </Stack>
      </AccordionSummary>
      <AccordionDetails id={contentId}>
        <Stack spacing={0}>
          {steps.map((step, index) => {
            const presentation = statePresentation[step.state]
            const facts = (step.facts || []).filter(
              (fact) => fact.label.trim() && fact.value.trim(),
            )
            return (
              <Box
                key={step.key}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: '32px minmax(0, 1fr)',
                  columnGap: 1.25,
                }}
              >
                <Stack alignItems="center">
                  <presentation.Icon
                    color={presentation.color === 'default'
                      ? 'disabled'
                      : presentation.color}
                    sx={{ fontSize: 22, mt: 0.25 }}
                  />
                  {index < steps.length - 1 ? (
                    <Box
                      aria-hidden
                      sx={{
                        width: 2,
                        minHeight: 26,
                        flex: 1,
                        bgcolor: 'divider',
                        my: 0.5,
                      }}
                    />
                  ) : null}
                </Stack>
                <Box sx={{ pb: index < steps.length - 1 ? 2 : 0 }}>
                  <Stack
                    direction="row"
                    spacing={0.75}
                    alignItems="center"
                    flexWrap="wrap"
                    useFlexGap
                  >
                    <Typography variant="subtitle2" fontWeight={700}>
                      {index + 1}. {step.label}
                    </Typography>
                    <Chip
                      size="small"
                      color={presentation.color}
                      variant="outlined"
                      label={step.optional
                        ? `${presentation.label} · optional`
                        : presentation.label}
                      sx={{ height: 22, minHeight: 22 }}
                    />
                  </Stack>
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mt: 0.5 }}
                  >
                    {step.description}
                  </Typography>
                  {facts.length ? (
                    <Box
                      component="dl"
                      aria-label={`${step.label} operational facts`}
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: {
                          xs: '1fr',
                          sm: 'repeat(2, minmax(0, 1fr))',
                        },
                        gap: 0.75,
                        mt: 1,
                        mb: 0,
                      }}
                    >
                      {facts.map((fact) => {
                        const factKey = `${step.key}:${fact.label}`
                        return (
                        <Box
                          key={factKey}
                          sx={{
                            minWidth: 0,
                            border: 1,
                            borderColor: 'divider',
                            borderRadius: 1,
                            px: 1,
                            py: 0.75,
                          }}
                        >
                          <Typography
                            component="dt"
                            variant="caption"
                            color="text.secondary"
                          >
                            {fact.label}
                          </Typography>
                          <Stack
                            component="dd"
                            direction="row"
                            spacing={0.5}
                            alignItems="flex-start"
                            justifyContent="space-between"
                            sx={{ m: 0, mt: 0.25 }}
                          >
                            <Typography
                              variant="body2"
                              fontWeight={600}
                              sx={{ overflowWrap: 'anywhere', minWidth: 0 }}
                            >
                              {fact.value}
                            </Typography>
                            {fact.copyable ? (
                              <Tooltip
                                title={copiedFact === factKey
                                  ? 'Copied'
                                  : `Copy ${fact.label}`}
                              >
                                <IconButton
                                  size="small"
                                  aria-label={`Copy ${fact.label}`}
                                  onClick={() => {
                                    void navigator.clipboard
                                      .writeText(fact.value)
                                      .then(() => {
                                        setCopiedFact(factKey)
                                        window.setTimeout(
                                          () => setCopiedFact(''),
                                          1_500,
                                        )
                                      })
                                      .catch(() => undefined)
                                  }}
                                  sx={{ mt: -0.5, mr: -0.5 }}
                                >
                                  <ContentCopyRounded sx={{ fontSize: 16 }} />
                                </IconButton>
                              </Tooltip>
                            ) : null}
                          </Stack>
                        </Box>
                        )
                      })}
                    </Box>
                  ) : null}
                  {step.action ? (
                    <Box
                      sx={{
                        mt: 1,
                        minWidth: 0,
                        '& .MuiButton-root': {
                          flexShrink: 0,
                          maxWidth: '100%',
                          whiteSpace: 'nowrap',
                        },
                        '& > .MuiStack-root': {
                          flexWrap: 'wrap',
                        },
                      }}
                    >
                      {step.action}
                    </Box>
                  ) : null}
                </Box>
              </Box>
            )
          })}
        </Stack>
      </AccordionDetails>
    </Accordion>
  )
}
