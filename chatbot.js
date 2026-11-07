// Chat is intentionally grounded in the model report; it makes no local claims.
const chatMessages = [];
let chatMessageId = 0;

function addMessage(type, content) {
  chatMessages.push({ id: ++chatMessageId, type, content, timestamp: new Date() });
}

function renderChatMessages() {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  container.replaceChildren();
  chatMessages.forEach(message => {
    const item = document.createElement('div');
    item.className = `chat-message ${message.type}`;
    const icon = document.createElement('div');
    icon.className = 'message-icon';
    icon.textContent = message.type === 'user' ? 'User' : 'AI';
    const content = document.createElement('div');
    content.className = 'message-content';
    const text = document.createElement('p');
    text.textContent = message.content;
    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = message.timestamp.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    content.append(text, time); item.append(icon, content); container.appendChild(item);
  });
  container.scrollTop = container.scrollHeight;
}

function sendMessage() {
  const input = document.getElementById('chatInput');
  if (!input?.value.trim()) return;
  addMessage('user', input.value.trim()); input.value = '';
  const report = window.CortexAnalysis?.snapshot?.().analysis;
  addMessage('assistant', report
    ? 'This interface is ready for a backend chat service grounded in the returned Lupus Cortex report. It will not create official environmental values in the browser.'
    : 'Current Lupus Cortex analysis is unavailable, so I cannot make a location-specific environmental claim.');
  renderChatMessages();
}

function initChatbot() {
  if (!chatMessages.length) addMessage('assistant', 'Select a location and request an analysis. I can explain model-returned evidence once the backend chat service is connected.');
  renderChatMessages();
  const send = document.getElementById('sendChatBtn');
  const input = document.getElementById('chatInput');
  if (send) send.onclick = sendMessage;
  if (input) input.onkeydown = event => { if (event.key === 'Enter') sendMessage(); };
}
