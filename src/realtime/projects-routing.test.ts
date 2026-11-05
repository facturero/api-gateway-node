import { describe, expect, it } from 'vitest';
import { projectsChangedMessage } from './projects-routing';

describe('aviso de tablero en vivo (projects.changed)', () => {
  it('lleva solo qué proyectos y qué tarea cambiaron: nunca el título ni el comentario', () => {
    const out = projectsChangedMessage('projects.comment.created', {
      organizationId: 'org-1',
      taskId: 't-1',
      title: 'Contrato confidencial',
      excerpt: 'el precio es…',
      projectIds: ['p-1', 'p-2'],
      userIds: ['u-1'],
    });
    expect(out).toEqual({ organizationId: 'org-1', message: { event: 'projects.comment.created', projectIds: ['p-1', 'p-2'], taskId: 't-1' } });
  });

  it('un evento de proyecto usa su projectId', () => {
    expect(projectsChangedMessage('projects.section.created', { organizationId: 'o', projectId: 'p-9', name: 'Hecho' })?.message).toEqual({
      event: 'projects.section.created',
      projectIds: ['p-9'],
      taskId: null,
    });
  });

  it('sin organización, o de otro dominio, no avisa', () => {
    expect(projectsChangedMessage('projects.task.created', { taskId: 't' })).toBeNull();
    expect(projectsChangedMessage('billing.invoice.issued', { organizationId: 'o' })).toBeNull();
  });
});
