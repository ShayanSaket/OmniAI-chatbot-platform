'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api-client';
import { SUPPORTED_LANGUAGES, organizationUpdateSchema } from '@/lib/validation';

export interface OrganizationFormValues {
  name: string;
  industry: string | null;
  website: string | null;
  timezone: string;
  defaultLanguage: string;
  messageRetentionDays: number | null;
}

// Form-level schema: text inputs produce strings, so empty strings map to null.
const formSchema = z.object({
  name: z.string(),
  industry: z.string(),
  website: z.string(),
  timezone: z.string(),
  defaultLanguage: z.string(),
  messageRetentionDays: z.string().regex(/^\d*$/, 'Enter a whole number of days'),
});
type FormValues = z.infer<typeof formSchema>;

function toPayload(v: FormValues) {
  return {
    name: v.name,
    industry: v.industry.trim() || null,
    website: v.website.trim() || null,
    timezone: v.timezone,
    defaultLanguage: v.defaultLanguage,
    messageRetentionDays: v.messageRetentionDays ? Number(v.messageRetentionDays) : null,
  };
}

export function OrganizationForm({ initial, canEdit }: { initial: OrganizationFormValues; canEdit: boolean }) {
  const router = useRouter();
  const timeZones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return [initial.timezone];
    }
  }, [initial.timezone]);

  const form = useForm<FormValues>({
    resolver: zodResolver(
      formSchema.superRefine((v, ctx) => {
        const parsed = organizationUpdateSchema.safeParse(toPayload(v));
        if (!parsed.success) {
          for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: issue.path });
        }
      }),
    ),
    defaultValues: {
      name: initial.name,
      industry: initial.industry ?? '',
      website: initial.website ?? '',
      timezone: initial.timezone,
      defaultLanguage: initial.defaultLanguage,
      messageRetentionDays: initial.messageRetentionDays?.toString() ?? '',
    },
  });

  async function onSubmit(values: FormValues) {
    try {
      await api('/api/v1/organization', { method: 'PATCH', json: toPayload(values) });
      toast.success('Organization updated');
      form.reset(values);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save changes');
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
        {!canEdit && (
          <p className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <Lock className="h-4 w-4" /> Only owners can change organization settings.
          </p>
        )}
        <fieldset disabled={!canEdit} className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Organization name</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="industry"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Industry</FormLabel>
                <FormControl>
                  <Input placeholder="e.g. Software & Digital Solutions" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="website"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Website</FormLabel>
                <FormControl>
                  <Input type="url" placeholder="https://example.com" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="timezone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Time zone</FormLabel>
                <Select value={field.value} onValueChange={field.onChange} disabled={!canEdit}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="max-h-72">
                    {timeZones.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz.replace(/_/g, ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>Used for business hours and analytics.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="defaultLanguage"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Default language</FormLabel>
                <Select value={field.value} onValueChange={field.onChange} disabled={!canEdit}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {SUPPORTED_LANGUAGES.map((l) => (
                      <SelectItem key={l.code} value={l.code}>
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>The AI still replies in the customer&apos;s language.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="messageRetentionDays"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Conversation retention (days)</FormLabel>
                <FormControl>
                  <Input inputMode="numeric" placeholder="Keep indefinitely" {...field} />
                </FormControl>
                <FormDescription>Closed conversations older than this are deleted (30–3650).</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </fieldset>
        {canEdit && (
          <div className="flex justify-end border-t pt-5">
            <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
              {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </div>
        )}
      </form>
    </Form>
  );
}
