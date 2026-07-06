import { type CSSProperties, type FC, type SVGProps } from 'react';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconChartBar,
  IconCheck,
  IconCircle,
  IconCircleCheckFilled,
  IconChecklist,
  IconChevronRight,
  IconServer,
  IconCopy,
  IconCpu,
  IconDeviceLaptop,
  IconDeviceSdCard,
  IconDots,
  IconActivity,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconKey,
  IconLoader2,
  IconRefresh,
  IconMoon,
  IconPin,
  IconPinFilled,
  IconPlayerPlay,
  IconPlayerStopFilled,
  IconPlus,
  IconRobot,
  IconSettings,
  IconSparkles,
  IconSquare,
  IconSun,
  IconTextWrap,
  IconTool,
  IconTrash,
  IconWifi,
  IconWifiOff,
  IconX,
  type TablerIcon,
} from '@tabler/icons-react';
import { CentralIcon, type CentralIconVariant } from '@/lib/central-icons';

export type AppIcon = FC<SVGProps<SVGSVGElement>>;

function adaptIcon(Component: TablerIcon): AppIcon {
  return function AdaptedIcon(props) {
    return <Component {...(props as SVGProps<SVGSVGElement>)} />;
  };
}

function centralIconWrapper(name: string, variant?: CentralIconVariant): AppIcon {
  return function CentralIconWrapper({ className, style, ...rest }) {
    const ariaLabelRaw = (rest as { ['aria-label']?: unknown })['aria-label'];
    const label = typeof ariaLabelRaw === 'string' ? ariaLabelRaw : undefined;
    return (
      <CentralIcon
        name={name}
        variant={variant}
        className={typeof className === 'string' ? className : undefined}
        style={style as CSSProperties | undefined}
        label={label}
      />
    );
  };
}

export const AlertTriangleIcon = adaptIcon(IconAlertTriangle);
export const ArrowLeftIcon = adaptIcon(IconArrowLeft);
export const BotIcon = adaptIcon(IconRobot);
export const ChartBarIcon = adaptIcon(IconChartBar);
export const CheckIcon = adaptIcon(IconCheck);
export const ChecklistIcon = adaptIcon(IconChecklist);
export const CircleIcon = adaptIcon(IconCircle);
export const CircleCheckFilledIcon = adaptIcon(IconCircleCheckFilled);
export const ChevronRightIcon = adaptIcon(IconChevronRight);
export const ServerIcon = adaptIcon(IconServer);
export const ClockIcon = centralIconWrapper('clock');
export const ComposerSendArrowIcon = centralIconWrapper('arrow-up');
export const CopyIcon = adaptIcon(IconCopy);
export const CpuIcon = adaptIcon(IconCpu);
export const DeviceLaptopIcon = adaptIcon(IconDeviceLaptop);
export const EllipsisIcon = adaptIcon(IconDots);
export const ExternalLinkIcon = adaptIcon(IconExternalLink);
export const EyeIcon = adaptIcon(IconEye);
export const EyeOffIcon = adaptIcon(IconEyeOff);
export const KeyIcon = adaptIcon(IconKey);
export const Loader2Icon = adaptIcon(IconLoader2);
export const MemoryIcon = adaptIcon(IconActivity);
export const NetworkIcon = adaptIcon(IconDeviceSdCard);
export const MoonIcon = adaptIcon(IconMoon);
export const PinIcon = adaptIcon(IconPin);
export const PinFilledIcon = adaptIcon(IconPinFilled);
export const PlayIcon = adaptIcon(IconPlayerPlay);
export const PlusIcon = adaptIcon(IconPlus);
export const RefreshIcon = adaptIcon(IconRefresh);
export const SettingsIcon = adaptIcon(IconSettings);
export const SparklesIcon = adaptIcon(IconSparkles);
export const StopFilledIcon = adaptIcon(IconPlayerStopFilled);
export const StopIcon = adaptIcon(IconSquare);
export const SunIcon = adaptIcon(IconSun);
export const TerminalIcon = centralIconWrapper('console');
export const TextWrapIcon = adaptIcon(IconTextWrap);
export const TrashIcon = adaptIcon(IconTrash);
export const WifiIcon = adaptIcon(IconWifi);
export const WifiOffIcon = adaptIcon(IconWifiOff);
export const WizardsIcon = adaptIcon(IconTool);
export const ChatBubbleIcon = centralIconWrapper('bubble-text');
export const XIcon = adaptIcon(IconX);
