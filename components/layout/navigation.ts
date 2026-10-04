import {
  BarChart3,
  BookOpen,
  Bot,
  Inbox,
  LayoutDashboard,
  MessageCircle,
  Plug,
  Settings,
  Target,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { hasPermission, type Permission, type Role } from '@/lib/permissions';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission: Permission;
  /** Shown with a "Soon" marker until the module ships. */
  comingSoon?: boolean;
}

export interface NavSection {
  label?: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, permission: 'dashboard:view' },
      { href: '/inbox', label: 'Inbox', icon: Inbox, permission: 'inbox:access' },
      { href: '/customers', label: 'Customers', icon: Users, permission: 'customers:view' },
      { href: '/leads', label: 'Leads', icon: Target, permission: 'leads:view' },
    ],
  },
  {
    label: 'AI',
    items: [
      { href: '/knowledge', label: 'Knowledge Base', icon: BookOpen, permission: 'knowledge:manage' },
      { href: '/agent', label: 'AI Agent', icon: Bot, permission: 'bot:manage' },
      { href: '/channels', label: 'Channels', icon: MessageCircle, permission: 'bot:manage' },
      { href: '/automations', label: 'Automations', icon: Workflow, permission: 'automations:manage' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/analytics', label: 'Analytics', icon: BarChart3, permission: 'analytics:view' },
      { href: '/integrations', label: 'Integrations', icon: Plug, permission: 'integrations:manage' },
      { href: '/settings', label: 'Settings', icon: Settings, permission: 'team:view' },
    ],
  },
];

export function navForRole(role: Role): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => hasPermission(role, item.permission)),
  })).filter((section) => section.items.length > 0);
}
