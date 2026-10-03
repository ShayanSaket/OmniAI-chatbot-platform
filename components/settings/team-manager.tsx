'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { formatDistanceToNowStrict } from 'date-fns';
import { Loader2, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api, ApiError } from '@/lib/api-client';
import { canGrantRole, checkMemberChange, hasPermission, ROLES, type Role } from '@/lib/permissions';
import { cn, initials } from '@/lib/utils';
import { addMemberSchema, type AddMemberInput } from '@/lib/validation';

export interface TeamMember {
  id: string;
  role: Role;
  createdAt: string;
  user: { id: string; name: string | null; email: string; lastLoginAt: string | null };
}

const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  OWNER: { label: 'Owner', description: 'Full access, including billing, integrations and organization settings' },
  ADMIN: { label: 'Admin', description: 'Manages the chatbot, knowledge, customers, agents and analytics' },
  AGENT: { label: 'Agent', description: 'Works in the inbox and customer conversations' },
};

function AddMemberDialog({ actorRole, open, onOpenChange }: { actorRole: Role; open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const form = useForm<AddMemberInput>({
    resolver: zodResolver(addMemberSchema),
    defaultValues: { name: '', email: '', role: 'AGENT', password: '' },
  });

  async function onSubmit(values: AddMemberInput) {
    try {
      await api('/api/v1/team', { method: 'POST', json: values });
      toast.success(`${values.name} was added to the team`, {
        description: 'Share the temporary password with them securely.',
      });
      form.reset();
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) {
        for (const [field, messages] of Object.entries(err.fieldErrors)) {
          if (messages?.[0]) form.setError(field as keyof AddMemberInput, { message: messages[0] });
        }
      }
      toast.error(err instanceof Error ? err.message : 'Could not add member');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add team member</DialogTitle>
          <DialogDescription>Create an account for a colleague and choose their access level.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Role</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ROLES.filter((r) => canGrantRole(actorRole, r)).map((r) => (
                        <SelectItem key={r} value={r}>
                          {ROLE_INFO[r].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>{ROLE_INFO[field.value].description}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Temporary password</FormLabel>
                  <FormControl>
                    <Input type="password" autoComplete="new-password" {...field} />
                  </FormControl>
                  <FormDescription>At least 10 characters, with a letter and a number.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add member
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function TeamManager({ members, actorRole, actorUserId }: { members: TeamMember[]; actorRole: Role; actorUserId: string }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const canManage = hasPermission(actorRole, 'team:manage');

  async function changeRole(member: TeamMember, role: Role) {
    setPending(member.id);
    try {
      await api(`/api/v1/team/${member.id}`, { method: 'PATCH', json: { role } });
      toast.success(`${member.user.name ?? member.user.email} is now ${ROLE_INFO[role].label.toLowerCase()}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change role');
    } finally {
      setPending(null);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    const member = removing;
    setPending(member.id);
    try {
      await api(`/api/v1/team/${member.id}`, { method: 'DELETE' });
      toast.success(`${member.user.name ?? member.user.email} was removed`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove member');
    } finally {
      setPending(null);
      setRemoving(null);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {members.length} {members.length === 1 ? 'member' : 'members'}
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <UserPlus className="mr-2 h-4 w-4" /> Add member
          </Button>
        )}
      </div>

      <ul className="divide-y rounded-lg border">
        {members.map((m) => {
          const isSelf = m.user.id === actorUserId;
          const roleOptions = ROLES.filter(
            (r) => r === m.role || !checkMemberChange({ actorRole, actorIsTarget: isSelf, targetRole: m.role, newRole: r }),
          );
          const editable = canManage && roleOptions.length > 1;
          const removable = canManage && !checkMemberChange({ actorRole, actorIsTarget: isSelf, targetRole: m.role });
          const display = m.user.name ?? m.user.email;

          return (
            <li key={m.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-3', pending === m.id && 'opacity-60')}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                {initials(display)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {display}
                  {isSelf && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {m.user.email} ·{' '}
                  {m.user.lastLoginAt
                    ? `active ${formatDistanceToNowStrict(new Date(m.user.lastLoginAt), { addSuffix: true })}`
                    : 'never signed in'}
                </p>
              </div>
              {editable ? (
                <Select value={m.role} onValueChange={(r) => changeRole(m, r as Role)} disabled={pending === m.id}>
                  <SelectTrigger className="h-8 w-[110px] text-xs" aria-label={`Role for ${display}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((r) => (
                      <SelectItem key={r} value={r} className="text-xs">
                        {ROLE_INFO[r].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                  {ROLE_INFO[m.role].label}
                </span>
              )}
              {canManage && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  disabled={!removable || pending === m.id}
                  onClick={() => setRemoving(m)}
                  aria-label={`Remove ${display}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {canManage && <AddMemberDialog actorRole={actorRole} open={adding} onOpenChange={setAdding} />}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.user.name ?? removing?.user.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              They will immediately lose access to this workspace. Conversations they handled are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Remove member
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
