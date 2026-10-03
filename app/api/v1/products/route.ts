import { NextResponse } from 'next/server';
import { productSchema } from '@/lib/validation';
import { requireApiAuth } from '@/server/auth/session';
import { parseJson, route } from '@/server/http';
import { createProduct, listProducts } from '@/server/modules/products/product-service';

export const GET = route(async () => {
  const ctx = await requireApiAuth('bot:manage');
  return NextResponse.json({ data: await listProducts(ctx) });
});

export const POST = route(async (req) => {
  const ctx = await requireApiAuth('bot:manage');
  const input = await parseJson(req, productSchema);
  return NextResponse.json({ data: await createProduct(ctx, input) }, { status: 201 });
});
