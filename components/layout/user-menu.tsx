'use client';

import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { LogOut, Settings } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { hasPermission, type Role } from '@/lib/permissions';
import { initials } from '@/lib/utils';
import type { ShellUser } from './app-shell';

const ROLE_LABEL: Record<Role, string> = { OWNER: 'Owner', ADMIN: 'Admin', AGENT: 'Agent' };

export function UserMenu({ user, role }: { user: ShellUser; role: Role }) {
  const display = user.name ?? user.email;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-2.5 rounded-full p-0.5 pr-2 outline-none ring-ring transition-colors hover:bg-muted focus-visible:ring-2 sm:pr-3"
        aria-label="Account menu"
      >
        <Avatar className="h-8 w-8">
          <AvatarFallback className="bg-gradient-to-br from-indigo-500 to-violet-500 text-xs font-semibold text-white">
            {initials(display)}
          </AvatarFallback>
        </Avatar>
        <span className="hidden text-left sm:block">
          <span className="block max-w-[160px] truncate text-sm font-medium leading-tight">{display}</span>
          <span className="block text-[11px] leading-tight text-muted-foreground">{ROLE_LABEL[role]}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium">{display}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {hasPermission(role, 'team:view') && (
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <Settings className="mr-2 h-4 w-4" /> Settings
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => signOut({ callbackUrl: '/login' })}>
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
