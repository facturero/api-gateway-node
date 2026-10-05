import { describe, expect, it } from 'vitest';
import { catalogRoutingOrgs } from './catalog-routing';

const ORG = '312179f0-f4f4-438d-8e7c-e02cbc73ea6b';

describe('catalogRoutingOrgs', () => {
  it.each([
    'product.product.created',
    'product.product.disabled',
    'product.category.updated',
    'product.category.deleted',
    'customer.customer.created',
    'customer.contact.deleted',
    'identity.user.disabled',
    'identity.user.enabled',
    'identity.user.role_assigned',
    'identity.user.establishments_updated',
  ])('%s avisa a la organización', (key) => {
    expect(catalogRoutingOrgs(key, { organizationId: ORG })).toEqual([ORG]);
  });

  it.each([
    'product.unit.created',
    'identity.role.updated',
    'tax.tax_rate.upserted',
    'billing.invoice.issued',
    'plugin.activated',
  ])('%s no es del catálogo', (key) => {
    expect(catalogRoutingOrgs(key, { organizationId: ORG })).toEqual([]);
  });

  it('sin organizationId no hay sala a la que avisar', () => {
    expect(catalogRoutingOrgs('product.category.updated', {})).toEqual([]);
    expect(catalogRoutingOrgs('identity.user.disabled', { organizationId: 5 })).toEqual([]);
  });

  it('restablecer contraseña y completar perfil avisan a TODAS las organizaciones del usuario', () => {
    const ORG2 = '00000000-0000-4000-8000-000000000002';
    expect(
      catalogRoutingOrgs('identity.user.password_reset_completed', { userId: 'u', organizationIds: [ORG, ORG2] }),
    ).toEqual([ORG, ORG2]);
    expect(catalogRoutingOrgs('identity.user.profile_completed', { organizationIds: [ORG] })).toEqual([ORG]);
  });

  it('sin organizaciones (evento viejo o usuario sin membresía activa) no hay a quién avisar', () => {
    expect(catalogRoutingOrgs('identity.user.password_reset_completed', { userId: 'u', email: 'a@b.c' })).toEqual([]);
    expect(catalogRoutingOrgs('identity.user.password_reset_completed', { organizationIds: [] })).toEqual([]);
  });

  it('ignora ids que no son texto y no repite una organización', () => {
    expect(catalogRoutingOrgs('identity.user.disabled', { organizationId: ORG, organizationIds: [ORG, 5, null, ''] })).toEqual([ORG]);
  });
});
