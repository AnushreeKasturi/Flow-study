import { byId } from '../dom';
import { sendToRoom } from './socket';
import { notify } from './feedback';
import { api } from './api';

let username: string | null = null;
let aiPending = false;
const chatMessages = byId<HTMLElement>('chat-messages');
const chatInput = byId<HTMLTextAreaElement>('chat-input');
const sendBtn = byId<HTMLButtonElement>('send-chat-btn');

let onOthers: ((sender: string, text: string) => void) | undefined;
let nameOf: ((userId: string) => string | undefined) | undefined;
export const initChat = (_roomId: string, user: string, onMessageFromOthers?: (sender: string, text: string) => void, displayName?: (userId: string) => string | undefined) => {
    username = user;
    onOthers = onMessageFromOthers;
    nameOf = displayName;
    sendBtn.onclick = sendMessage;
    chatInput.onkeydown = event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
    };
};

// `own` marks a message this browser just sent. Everything else arrives from
// the room, stamped by the database with who really sent it (`from`). The name
// shown comes from that stamp, not from what the message says about itself, so
// nobody can post as someone else or pass their own words off as the assistant's.
export const handleIncomingMessage = (message: unknown, own = false) => {
    if (!message || typeof message !== 'object' || !('text' in message) || !('sender' in message) || typeof message.text !== 'string' || typeof message.sender !== 'string') return;
    const from = 'from' in message && typeof message.from === 'string' ? message.from : null;
    const claimed = message.sender.slice(0, 80);
    const text = message.text.slice(0, 4000);
    const assistant = claimed === 'AI Assistant';
    // A stamped sender we can't put a name to gets a neutral label, never the name the message claims.
    // (A message with no stamp at all can only arrive on servers that have not applied sql/009.)
    const verified = from ? nameOf?.(from) ?? 'Someone in the room' : undefined;
    const label = own && !assistant ? 'You'
        : assistant ? (own || !from ? 'AI Assistant' : `AI Assistant, asked by ${verified}`)
        : verified ?? claimed;
    const div = document.createElement('div');
    div.className = 'chat-message' + (own && !assistant ? ' own-message' : '') + (assistant ? ' ai-message' : '');
    const name = document.createElement('div');
    name.className = 'message-sender';
    name.textContent = label;
    const body = document.createElement('div');
    body.textContent = text;
    div.append(name, body);
    chatMessages.append(div);
    // Keep this ephemeral conversation bounded during long study sessions.
    while (chatMessages.children.length > 300) chatMessages.firstElementChild!.remove();
    chatMessages.scrollTop = chatMessages.scrollHeight;
    if (!own) onOthers?.(label, text);
};

async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || text.length > 300) return;
    const isAi = /^\/ai(?:\s|$)/.test(text);
    if (isAi && aiPending) return;
    if (!isAi) {
        chatInput.value = '';
        try {
            const status = await sendToRoom('chat-message', { sender: username, text });
            if (status && status !== 'ok') throw new Error('Message delivery failed');
            handleIncomingMessage({ sender: username, text }, true);
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
        handleIncomingMessage(message, true);
        await sendToRoom('chat-message', message);
    } catch {
        if (!chatInput.value) chatInput.value = text;
        notify('The study assistant is unavailable. Your question is ready to retry.', 'error');
    } finally {
        aiPending = false;
        pending.classList.add('hidden');
    }
}
