import { describe, expect, it } from 'vitest';
import { catalogRoutingOrg } from './catalog-routing';

const ORG = '312179f0-f4f4-438d-8e7c-e02cbc73ea6b';

describe('catalogRoutingOrg', () => {
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
    expect(catalogRoutingOrg(key, { organizationId: ORG })).toBe(ORG);
  });

  it.each([
    'product.unit.created',
    'identity.role.updated',
    'tax.tax_rate.upserted',
    'billing.invoice.issued',
    'plugin.activated',
  ])('%s no es del catálogo', (key) => {
    expect(catalogRoutingOrg(key, { organizationId: ORG })).toBeNull();
  });

  it('sin organizationId no hay sala a la que avisar', () => {
    expect(catalogRoutingOrg('product.category.updated', {})).toBeNull();
    expect(catalogRoutingOrg('identity.user.disabled', { organizationId: 5 })).toBeNull();
  });
});
