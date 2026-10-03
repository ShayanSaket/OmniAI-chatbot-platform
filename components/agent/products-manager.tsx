'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api-client';
import { productSchema } from '@/lib/validation';
import { Field, fieldErrorsFrom, SettingsSection } from './form-parts';

export interface ProductRow {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  description: string;
  price: number | null;
  currency: string;
  priceNote: string | null;
  url: string | null;
  isActive: boolean;
}

interface FormValues {
  name: string;
  sku: string;
  category: string;
  description: string;
  price: string;
  currency: string;
  priceNote: string;
  url: string;
  isActive: boolean;
}

const EMPTY: FormValues = { name: '', sku: '', category: '', description: '', price: '', currency: 'EUR', priceNote: '', url: '', isActive: true };

const toForm = (p: ProductRow): FormValues => ({
  name: p.name,
  sku: p.sku ?? '',
  category: p.category ?? '',
  description: p.description,
  price: p.price === null ? '' : String(p.price),
  currency: p.currency,
  priceNote: p.priceNote ?? '',
  url: p.url ?? '',
  isActive: p.isActive,
});

function toPayload(v: FormValues) {
  const price = v.price.trim().replace(',', '.');
  return {
    name: v.name,
    sku: v.sku.trim() || null,
    category: v.category.trim() || null,
    description: v.description,
    price: price === '' ? null : Number(price),
    currency: v.currency,
    priceNote: v.priceNote.trim() || null,
    url: v.url.trim() || null,
    isActive: v.isActive,
  };
}

export function formatPrice(p: Pick<ProductRow, 'price' | 'currency' | 'priceNote'>) {
  if (p.price === null) return 'On request';
  let amount: string;
  try {
    amount = new Intl.NumberFormat('en-GB', { style: 'currency', currency: p.currency }).format(p.price);
  } catch {
    amount = `${p.price} ${p.currency}`;
  }
  return p.priceNote ? `${amount} ${p.priceNote}` : amount;
}

function ProductDialog({ product, open, onOpenChange, onSaved }: { product: ProductRow | null; open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const [values, setValues] = useState<FormValues>(product ? toForm(product) : EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof FormValues>(k: K, v: FormValues[K]) => setValues((s) => ({ ...s, [k]: v }));

  async function save() {
    const payload = toPayload(values);
    if (values.price.trim() && Number.isNaN(payload.price)) {
      setErrors({ price: 'Enter a number, e.g. 399 or 49.90' });
      return;
    }
    const parsed = productSchema.safeParse(payload);
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api(product ? `/api/v1/products/${product.id}` : '/api/v1/products', { method: product ? 'PATCH' : 'POST', json: parsed.data });
      toast.success(product ? 'Product updated' : 'Product added');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setErrors(fieldErrorsFrom(err));
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{product ? 'Edit product' : 'Add product'}</DialogTitle>
          <DialogDescription>The assistant quotes prices only from this catalog or your knowledge base.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="p-name" error={errors.name}>
              <Input id="p-name" value={values.name} maxLength={120} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Category" htmlFor="p-category" error={errors.category}>
              <Input id="p-category" value={values.category} maxLength={60} placeholder="e.g. Plans" onChange={(e) => set('category', e.target.value)} />
            </Field>
          </div>
          <Field label="Description" htmlFor="p-description" error={errors.description} hint="What it includes and who it’s for. The AI uses this to recommend the right option.">
            <Textarea id="p-description" rows={3} maxLength={2000} value={values.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_90px_1fr]">
            <Field label="Price" htmlFor="p-price" error={errors.price} hint="Empty = on request">
              <Input id="p-price" inputMode="decimal" value={values.price} placeholder="399" onChange={(e) => set('price', e.target.value)} />
            </Field>
            <Field label="Currency" htmlFor="p-currency" error={errors.currency}>
              <Input id="p-currency" maxLength={3} value={values.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} />
            </Field>
            <Field label="Price note" htmlFor="p-note" error={errors.priceNote}>
              <Input id="p-note" maxLength={60} value={values.priceNote} placeholder="per month, net" onChange={(e) => set('priceNote', e.target.value)} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="SKU" htmlFor="p-sku" error={errors.sku}>
              <Input id="p-sku" maxLength={60} value={values.sku} onChange={(e) => set('sku', e.target.value)} />
            </Field>
            <Field label="Link" htmlFor="p-url" error={errors.url}>
              <Input id="p-url" type="url" value={values.url} placeholder="https://" onChange={(e) => set('url', e.target.value)} />
            </Field>
          </div>
          <label className="flex items-center gap-2.5 text-sm">
            <Switch checked={values.isActive} onCheckedChange={(v) => set('isActive', v)} aria-label="Available" />
            Available — the assistant may offer it
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {product ? 'Save' : 'Add product'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProductsManager({ products }: { products: ProductRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ product: ProductRow | null; key: number } | null>(null);
  const [deleting, setDeleting] = useState<ProductRow | null>(null);

  async function toggleActive(p: ProductRow, isActive: boolean) {
    try {
      await api(`/api/v1/products/${p.id}`, { method: 'PATCH', json: { isActive } });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update');
    }
  }

  async function remove(p: ProductRow) {
    try {
      await api(`/api/v1/products/${p.id}`, { method: 'DELETE' });
      toast.success('Product deleted');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete');
    }
  }

  return (
    <SettingsSection
      title="Products & prices"
      description="The catalog the assistant reads with its product lookup tool. If a price isn’t here or in the knowledge base, the assistant won’t make one up."
      action={
        <Button onClick={() => setEditing({ product: null, key: Date.now() })}>
          <Plus className="me-2 h-4 w-4" /> Add product
        </Button>
      }
    >
      {products.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm font-medium">No products yet</p>
          <p className="mt-1 text-sm text-muted-foreground">Add your plans, services or products so the assistant can answer pricing questions accurately.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Price</TableHead>
                <TableHead className="hidden md:table-cell">Category</TableHead>
                <TableHead>Available</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <p className="font-medium">{p.name}</p>
                    {p.description && <p className="line-clamp-1 max-w-md text-[13px] text-muted-foreground">{p.description}</p>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{formatPrice(p)}</TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground md:table-cell">{p.category ?? '—'}</TableCell>
                  <TableCell>
                    <Switch checked={p.isActive} onCheckedChange={(v) => toggleActive(p, v)} aria-label={`${p.name} available`} />
                  </TableCell>
                  <TableCell className="text-end">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setEditing({ product: p, key: Date.now() })} aria-label={`Edit ${p.name}`}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => setDeleting(p)} aria-label={`Delete ${p.name}`}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editing && (
        <ProductDialog
          key={editing.key}
          product={editing.product}
          open
          onOpenChange={(v) => !v && setEditing(null)}
          onSaved={() => router.refresh()}
        />
      )}
      <AlertDialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>The assistant will no longer offer it. To hide it temporarily, switch “Available” off instead.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && remove(deleting)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
