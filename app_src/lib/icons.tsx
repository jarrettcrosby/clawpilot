import RocketLaunchRounded from '@mui/icons-material/RocketLaunchRounded'
import CalendarMonthRounded from '@mui/icons-material/CalendarMonthRounded'
import BusinessCenterRounded from '@mui/icons-material/BusinessCenterRounded'
import StorefrontRounded from '@mui/icons-material/StorefrontRounded'
import SportsMotorsportsRounded from '@mui/icons-material/SportsMotorsportsRounded'
import LightbulbRounded from '@mui/icons-material/LightbulbRounded'
import DescriptionRounded from '@mui/icons-material/DescriptionRounded'
import FolderOpenRounded from '@mui/icons-material/FolderOpenRounded'
import FolderRounded from '@mui/icons-material/FolderRounded'
import DashboardRounded from '@mui/icons-material/DashboardRounded'
import ViewKanbanRounded from '@mui/icons-material/ViewKanbanRounded'
import TrendingUpRounded from '@mui/icons-material/TrendingUpRounded'
import SmartToyRounded from '@mui/icons-material/SmartToyRounded'
import WbSunnyRounded from '@mui/icons-material/WbSunnyRounded'
import SearchRounded from '@mui/icons-material/SearchRounded'
import MenuRounded from '@mui/icons-material/MenuRounded'
import HistoryRounded from '@mui/icons-material/HistoryRounded'
import type { SvgIconComponent } from '@mui/icons-material'

export const CategoryIcons: Record<string, SvgIconComponent> = {
  daily: CalendarMonthRounded,
  epi: BusinessCenterRounded,
  suburbia: StorefrontRounded,
  clawpilot: RocketLaunchRounded,
  p9ine: SportsMotorsportsRounded,
  concepts: LightbulbRounded,
}

export const CategoryLabels: Record<string, string> = {
  daily: 'Daily Journal',
  epi: 'EPI',
  suburbia: 'Suburbia',
  clawpilot: 'ClawPilot',
  p9ine: 'P9INE',
  concepts: 'Concepts',
}

export {
  RocketLaunchRounded as BrandIcon,
  DashboardRounded as DashboardIcon,
  DescriptionRounded as DocsIcon,
  ViewKanbanRounded as ProjectsIcon,
  TrendingUpRounded as PipelineIcon,
  SmartToyRounded as AgentsIcon,
  WbSunnyRounded as MorningIcon,
  SearchRounded as SearchIcon,
  MenuRounded as MenuIcon,
  FolderRounded as FolderIcon,
  FolderOpenRounded as FolderOpenIcon,
  DescriptionRounded as DocumentIcon,
  LightbulbRounded as ConceptIcon,
  HistoryRounded as VersionsIcon,
}