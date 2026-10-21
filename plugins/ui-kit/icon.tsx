/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/**
 * Named icons for inert contributions. Resources are plain data, so an app
 * names an icon (`icon: "kanban"`) instead of passing a component.
 * @module
 */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import {
  Archive,
  BarChart3,
  Bell,
  Bookmark,
  BookOpen,
  Bot,
  Box,
  Brain,
  Building2,
  Calendar,
  Check,
  Clock,
  Cloud,
  Code,
  Copy,
  Cpu,
  Database,
  Download,
  ExternalLink,
  FileText,
  Filter,
  Flag,
  Folder,
  Gauge,
  GitBranch,
  Globe,
  Heart,
  House,
  Image,
  Inbox,
  KeyRound,
  Laptop,
  Layers,
  LayoutGrid,
  Lightbulb,
  Link,
  List,
  Lock,
  LogOut,
  type LucideIcon,
  Mail,
  Map,
  MessageSquare,
  Mic,
  Network,
  PanelRight,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  Share2,
  Shield,
  Sparkles,
  SquareKanban,
  Star,
  Terminal,
  Trash2,
  Upload,
  User,
  UserPlus,
  Users,
  Wrench,
  Zap,
} from "lucide-react";
import { cn } from "./utils.ts";

const icons = {
  archive: Archive,
  bell: Bell,
  book: BookOpen,
  bookmark: Bookmark,
  bot: Bot,
  box: Box,
  brain: Brain,
  building: Building2,
  calendar: Calendar,
  chart: BarChart3,
  check: Check,
  clock: Clock,
  cloud: Cloud,
  code: Code,
  copy: Copy,
  cpu: Cpu,
  database: Database,
  download: Download,
  "external-link": ExternalLink,
  file: FileText,
  filter: Filter,
  flag: Flag,
  folder: Folder,
  gauge: Gauge,
  "git-branch": GitBranch,
  globe: Globe,
  grid: LayoutGrid,
  heart: Heart,
  home: House,
  image: Image,
  inbox: Inbox,
  kanban: SquareKanban,
  key: KeyRound,
  laptop: Laptop,
  layers: Layers,
  lightbulb: Lightbulb,
  link: Link,
  list: List,
  lock: Lock,
  logout: LogOut,
  mail: Mail,
  map: Map,
  message: MessageSquare,
  mic: Mic,
  network: Network,
  panel: PanelRight,
  paperclip: Paperclip,
  pencil: Pencil,
  plus: Plus,
  refresh: RefreshCw,
  rocket: Rocket,
  search: Search,
  settings: Settings,
  share: Share2,
  shield: Shield,
  sparkles: Sparkles,
  star: Star,
  terminal: Terminal,
  trash: Trash2,
  upload: Upload,
  user: User,
  "user-plus": UserPlus,
  users: Users,
  wrench: Wrench,
  zap: Zap,
} satisfies Record<string, LucideIcon>;

/** A name an inert contribution may use for its icon. */
export type IconName = keyof typeof icons;
/** Every icon name, for documentation and validation. */
export const iconNames: readonly IconName[] = Object.keys(icons) as IconName[];

/** Renders a named icon; an unknown name renders `fallback` (nothing by default). */
export function Icon(
  { name, className, fallback = null }: {
    name: string | undefined;
    className?: string;
    fallback?: React.ReactNode;
  },
): React.ReactElement | null {
  const Component = name && Object.hasOwn(icons, name)
    ? icons[name as IconName]
    : undefined;
  if (!Component) return fallback ? <>{fallback}</> : null;
  return <Component aria-hidden="true" className={cn("size-4", className)} />;
}
