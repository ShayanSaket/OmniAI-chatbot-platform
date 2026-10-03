import { NextResponse } from 'next/server';
import { productUpdateSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { deleteProduct, updateProduct } from '@/server/modules/products/product-service';

type Params = { productId: string };

export const PATCH = route<Params>(async (req, { params }) => {
  const ctx = await requireApiAuth('bot:manage');
  const input = await parseJson(req, productUpdateSchema);
  return NextResponse.json({ data: await updateProduct(ctx, params.productId, input) });
});

export const DELETE = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('bot:manage');
  await deleteProduct(ctx, params.productId);
  return new NextResponse(null, { status: 204 });
});
