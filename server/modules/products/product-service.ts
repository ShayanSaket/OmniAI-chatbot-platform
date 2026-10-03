import 'server-only';
import type { Product } from '@prisma/client';
import { hasPermission } from '@/lib/permissions';
import type { ProductInput, ProductUpdateInput } from '@/lib/validation';
import type { ServiceContext } from '../../context';
import { AppError, forbidden, notFound } from '../../errors';
import { auditFromContext } from '../audit/audit-service';

const MAX_PRODUCTS = 500;

function assertCanManage(ctx: ServiceContext) {
  if (!hasPermission(ctx.role, 'bot:manage')) throw forbidden();
}

export function serializeProduct(p: Product) {
  return {
    ...p,
    price: p.price === null ? null : Number(p.price),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
export type ProductDto = ReturnType<typeof serializeProduct>;

export async function listProducts(ctx: ServiceContext) {
  assertCanManage(ctx);
  const rows = await ctx.db.product.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }], take: MAX_PRODUCTS });
  return rows.map(serializeProduct);
}

export async function createProduct(ctx: ServiceContext, input: ProductInput) {
  assertCanManage(ctx);
  if ((await ctx.db.product.count()) >= MAX_PRODUCTS) {
    throw new AppError('BAD_REQUEST', `The catalog is limited to ${MAX_PRODUCTS} products.`);
  }
  const product = await ctx.db.product.create({ data: { ...input, organizationId: ctx.organizationId } });
  await auditFromContext(ctx, 'product.created', { type: 'Product', id: product.id }, { name: product.name });
  return serializeProduct(product);
}

export async function updateProduct(ctx: ServiceContext, id: string, input: ProductUpdateInput) {
  assertCanManage(ctx);
  if (!(await ctx.db.product.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Product');
  const product = await ctx.db.product.update({ where: { id }, data: input });
  await auditFromContext(ctx, 'product.updated', { type: 'Product', id }, { fields: Object.keys(input) });
  return serializeProduct(product);
}

export async function deleteProduct(ctx: ServiceContext, id: string) {
  assertCanManage(ctx);
  const existing = await ctx.db.product.findUnique({ where: { id }, select: { name: true } });
  if (!existing) throw notFound('Product');
  await ctx.db.product.delete({ where: { id } });
  await auditFromContext(ctx, 'product.deleted', { type: 'Product', id }, { name: existing.name });
}
