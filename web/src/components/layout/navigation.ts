import { FileUp, History, Inbox, LayoutDashboard, Settings, ShieldCheck, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** planned: route exists and explains its scope, but the feature is not built yet. */
  status: 'available' | 'planned';
  phase?: number;
  summary: string;
  capabilities: string[];
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Operations',
    items: [
      {
        to: '/',
        label: 'Overview',
        icon: LayoutDashboard,
        status: 'available',
        summary: 'Payment health, outstanding value and the work that needs attention.',
        capabilities: [],
      },
      {
        to: '/cases',
        label: 'Payment cases',
        icon: Inbox,
        status: 'available',
        summary: 'Every undelivered or inconsistent payment, tracked as a case until it is resolved.',
        capabilities: [],
      },
      {
        to: '/approvals',
        label: 'Approval centre',
        icon: ShieldCheck,
        status: 'available',
        summary: 'Explicit human approval for every proposed recovery payment.',
        capabilities: [
          'Original payment, proposed action, amount and evidence side by side',
          'Approver role required; proposers cannot approve their own proposals',
          'Duplicate-payment protection before anything is submitted',
          'Typed confirmation before execution',
        ],
      },
    ],
  },
  {
    label: 'Data and controls',
    items: [
      {
        to: '/import',
        label: 'Import batch',
        icon: FileUp,
        status: 'available',
        summary: 'Bring payment records in from CSV with validation and deterministic reconciliation.',
        capabilities: [],
      },
      {
        to: '/audit',
        label: 'Audit history',
        icon: History,
        status: 'available',
        summary: 'An append-only record of who did what, when, and what changed.',
        capabilities: [
          'Operator, action, timestamp, previous and new state',
          'Payment reference and outcome for every event',
          'Historical events are never edited or deleted',
        ],
      },
    ],
  },
];

export const SETTINGS_NAV_ITEM: NavItem = {
  to: '/settings',
  label: 'Settings',
  icon: Settings,
  status: 'available',
  summary: 'Organisation, roles and integration status. Secrets are never displayed.',
  capabilities: [
    'Organisation profile and user roles',
    'PayPal Sandbox connection status and webhook configuration',
    'AI investigation configuration',
    'Environment and version information',
  ],
};

export const ALL_NAV_ITEMS: NavItem[] = [...NAV_SECTIONS.flatMap((s) => s.items), SETTINGS_NAV_ITEM];
