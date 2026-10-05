// ¿Este evento del CRM debe hacer que las cajas POS de la organización vuelvan a sincronizar (`catalog.changed`)?
// El aviso no lleva datos: la caja hace un pull autenticado y el pull baja TODO (categorías, productos,
// usuarios, clientes), así que basta con avisar que "algo cambió".
//
// Antes solo avisaban product.product.* y customer.*. Visto el 2026-10-05 probando el POS contra el CRM real:
// renombrar o borrar una CATEGORÍA, o deshabilitar / dar de alta / cambiar roles o establecimientos de un
// USUARIO, solo llegaba a la caja en el siguiente ciclo programado (hasta 5 min), y un usuario deshabilitado
// seguía pudiendo entrar a la caja ese rato.
//
// Los impuestos (tax.tax_rate.upserted) NO se enrutan aquí: el evento no lleva organizationId (las tasas son
// por país, no por organización), así que no hay sala a la que avisar. Siguen entrando por el ciclo programado.

export function catalogRoutingOrg(routingKey: string, payload: Record<string, unknown>): string | null {
  const orgId = typeof payload.organizationId === 'string' ? payload.organizationId : null;
  if (!orgId) return null;

  if (routingKey.startsWith('product.product.')) return orgId;
  if (routingKey.startsWith('product.category.')) return orgId;
  if (routingKey.startsWith('customer.')) return orgId;
  // Solo los eventos de usuario (no identity.role.*: un rol cambiado se nota en los usuarios que lo tienen).
  if (routingKey.startsWith('identity.user.')) return orgId;
  return null;
}
