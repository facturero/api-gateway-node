/**
 * Tablero en vivo de Proyectos y tareas (entregable 2).
 *
 * Cada evento `projects.*` se convierte en un aviso MÍNIMO a la sala de la organización: `projects.changed` con qué proyectos y qué
 * tarea cambiaron, y nada más. El navegador que tenga abierto uno de esos proyectos (o esa tarea) vuelve a pedir los datos por REST,
 * y ahí projects-service aplica los permisos. Así un proyecto PRIVADO no filtra sus títulos ni comentarios a quien no es miembro,
 * aunque toda la organización comparta la sala.
 *
 * Aparte, si el evento trae `userIds` (a quién avisar), el hub lo manda a la campana de cada uno pasando por el gate de preferencias:
 * esa parte sí lleva el título, porque solo llega a quien projects-service eligió como destinatario.
 */
export interface ProjectsChanged {
  event: string;
  projectIds: string[];
  taskId: string | null;
}

export function projectsChangedMessage(routingKey: string, payload: Record<string, unknown>): { organizationId: string; message: ProjectsChanged } | null {
  if (!routingKey.startsWith('projects.')) return null;
  const organizationId = typeof payload.organizationId === 'string' ? payload.organizationId : null;
  if (!organizationId) return null;
  const projectIds = new Set<string>();
  if (Array.isArray(payload.projectIds)) for (const p of payload.projectIds) if (typeof p === 'string') projectIds.add(p);
  if (typeof payload.projectId === 'string') projectIds.add(payload.projectId);
  return {
    organizationId,
    message: {
      event: routingKey,
      projectIds: [...projectIds],
      taskId: typeof payload.taskId === 'string' ? payload.taskId : null,
    },
  };
}
