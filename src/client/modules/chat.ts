import { byId } from '../dom';
import { getSocket } from './socket';
import { notify } from './feedback';
import { api } from './api';

let username: string | null = null;
let aiPending = false;
const chatMessages = byId<HTMLElement>('chat-messages');
const chatInput = byId<HTMLTextAreaElement>('chat-input');
const sendBtn = byId<HTMLButtonElement>('send-chat-btn');

export const initChat = (_roomId: string, user: string) => {
    username = user;
    sendBtn.onclick = sendMessage;
    chatInput.onkeydown = event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
    };
};

export const handleIncomingMessage = (message: unknown) => {
    if (!message || typeof message !== 'object' || !('text' in message) || !('sender' in message) || typeof message.text !== 'string' || typeof message.sender !== 'string') return;
    const sender = message.sender.slice(0, 80);
    const text = message.text.slice(0, 4000);
    const div = document.createElement('div');
    div.className = 'chat-message' + (sender === username ? ' own-message' : '') + (sender === 'AI Assistant' ? ' ai-message' : '');
    const name = document.createElement('div');
    name.className = 'message-sender';
    name.textContent = sender === username ? 'You' : sender;
    const body = document.createElement('div');
    body.textContent = text;
    div.append(name, body);
    chatMessages.append(div);
    // Keep this ephemeral conversation bounded during long study sessions.
    while (chatMessages.children.length > 300) chatMessages.firstElementChild!.remove();
    chatMessages.scrollTop = chatMessages.scrollHeight;
};

async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || text.length > 300) return;
    const isAi = /^\/ai(?:\s|$)/.test(text);
    if (isAi && aiPending) return;
    const channel = getSocket();
    if (!isAi) {
        chatInput.value = '';
        try {
            const status = await channel?.send({ type: 'broadcast', event: 'chat-message', payload: { sender: username, text } });
            if (status && status !== 'ok') throw new Error('Message delivery failed');
            handleIncomingMessage({ sender: username, text });
        } catch {
            if (!chatInput.value) chatInput.value = text;
            notify('Message was not sent. Check your connection and try again.', 'error');
        }
        return;
    }

    const query = text.replace(/^\/ai\s*/, '').trim();
    if (!query) { notify('Add a question after /ai to ask the study assistant.'); return; }
    chatInput.value = '';
    aiPending = true;
    const pending = byId<HTMLElement>('ai-pending');
    pending.classList.remove('hidden');
    try {
        const response = await api('/api/ai', { message: query }, 20000);
        const data = await response.json();
        if (!response.ok) throw new Error('Assistant unavailable');
        if (typeof data.text !== 'string') throw new Error('Invalid assistant response');
        const message = { sender: 'AI Assistant', text: data.text };
        handleIncomingMessage(message);
        await channel?.send({ type: 'broadcast', event: 'chat-message', payload: message });
    } catch {
        if (!chatInput.value) chatInput.value = text;
        notify('The study assistant is unavailable. Your question is ready to retry.', 'error');
    } finally {
        aiPending = false;
        pending.classList.add('hidden');
    }
}
