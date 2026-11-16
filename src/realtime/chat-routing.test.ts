import { describe, expect, it } from 'vitest';
import { chatPlan } from './chat-routing';

const ORG = 'org-1';
const plan = (rk: string, p: Record<string, unknown>) => chatPlan(rk, { organizationId: ORG, conversationId: 'c1', ...p }, 'catalog:', 'user:');

describe('chatPlan', () => {
  it('mensaje nuevo: pide traer el mensaje y lo reparte a cada miembro con su aviso; campana a userIds', () => {
    const p = plan('chat.message.created', { messageId: 'm1', memberUserIds: ['a', 'b', 'c'], notifyUserIds: ['b'], hereUserIds: ['c'], userIds: ['b'] });
    expect(p?.deliver).toEqual({
      messageId: 'm1',
      event: 'chat.message.new',
      conversationId: 'c1',
      threadRootId: null,
      recipients: [
        { userId: 'a', notify: false, here: false },
        { userId: 'b', notify: true, here: false },
        { userId: 'c', notify: false, here: true },
      ],
    });
    expect(p?.bellUserIds).toEqual(['b']);
    expect(p?.emits).toEqual([]);
  });

  it('una edición se reparte igual pero no vuelve a avisar ni suena la campana', () => {
    const p = plan('chat.message.updated', { messageId: 'm1', memberUserIds: ['a'], notifyUserIds: ['a'], userIds: ['a'] });
    expect(p?.deliver?.event).toBe('chat.message.updated');
    expect(p?.deliver?.recipients).toEqual([{ userId: 'a', notify: false, here: false }]);
    expect(p?.bellUserIds).toEqual([]);
  });

  it('canal público: aviso mínimo a la organización, sin nombre', () => {
    const p = plan('chat.conversation.created', { kind: 'channel', visibility: 'public', name: 'ventas', memberUserIds: [] });
    expect(p?.emits).toEqual([{ room: 'catalog:org-1', event: 'chat.conversation.changed', data: { event: 'chat.conversation.created', conversationId: 'c1' } }]);
  });

  it('canal privado o DM: a sus miembros y a quien entró o salió, nunca a la organización', () => {
    const p = plan('chat.member.left', { kind: 'channel', visibility: 'private', memberUserIds: ['a'], userIds: ['b'] });
    expect(p?.emits.map((e) => e.room)).toEqual(['user:a', 'user:b']);
    expect(p?.emits.every((e) => !e.room.startsWith('catalog:'))).toBe(true);
  });

  it('leído: solo a quien leyó; reacciones: también a quien reaccionó', () => {
    expect(plan('chat.conversation.read', { userId: 'a', lastReadSeq: 7 })?.emits).toEqual([{ room: 'user:a', event: 'chat.read', data: { conversationId: 'c1', lastReadSeq: 7 } }]);
    const r = plan('chat.reaction.added', { messageId: 'm1', emoji: '👍', userId: 'z', memberUserIds: ['a'] });
    expect(r?.emits.map((e) => e.room)).toEqual(['user:a', 'user:z']);
    expect(r?.emits[0].data).toMatchObject({ added: true, emoji: '👍' });
  });

  it('sin organización o conversación, o fuera de chat.*: no hay plan', () => {
    expect(chatPlan('chat.message.created', { conversationId: 'c1', messageId: 'm' }, 'catalog:', 'user:')).toBeNull();
    expect(plan('projects.task.created', {})).toBeNull();
    expect(plan('chat.message.created', { memberUserIds: ['a'] })).toBeNull();
  });
});
