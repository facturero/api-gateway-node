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

// Organizaciones a las que avisar. La mayoría de los eventos trae `organizationId` (una); los de identidad que
// no pertenecen a una organización en concreto —restablecer contraseña, completar perfil— traen
// `organizationIds` (todas las del usuario): su contraseña y su nombre se espejan en las cajas de cada una.
export function catalogRoutingOrgs(routingKey: string, payload: Record<string, unknown>): string[] {
  const single = typeof payload.organizationId === 'string' ? [payload.organizationId] : [];
  const many = Array.isArray(payload.organizationIds)
    ? payload.organizationIds.filter((o): o is string => typeof o === 'string' && o.length > 0)
    : [];
  const orgs = [...new Set([...single, ...many])];
  if (orgs.length === 0) return [];

  if (routingKey.startsWith('product.product.')) return orgs;
  if (routingKey.startsWith('product.category.')) return orgs;
  if (routingKey.startsWith('customer.')) return orgs;
  // Solo los eventos de usuario (no identity.role.*: un rol cambiado se nota en los usuarios que lo tienen).
  if (routingKey.startsWith('identity.user.')) return orgs;
  return [];
}
