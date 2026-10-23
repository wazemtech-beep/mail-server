/**
 * AETHERMAIL — CLIENT STATE & SECURE LOGIC
 */

let state = {
  currentTab: 'webmail',
  domains: [],
  mailboxes: [],
  activeMailboxId: null,
  activeFolder: 'inbox',
  emails: [],
  selectedEmailId: null,
  logs: []
};

// Authorized Fetch Helper (Tenant Mailbox Scoped)
async function fetchWithAuth(url, options = {}) {
  const headers = {
    ...(options.headers || {})
  };
  if (state.activeMailboxId) {
    headers['x-mailbox-id'] = state.activeMailboxId;
  }
  return fetch(url, { ...options, headers });
}

document.addEventListener('DOMContentLoaded', async () => {
  setupSSE();
  await loadMailboxes();
  await loadDomains();
  await reloadEmails();
  await reloadLogs();

  // Background polling fallback (ensures new emails arrive on Vercel even if SSE closes)
  setInterval(async () => {
    if (state.activeMailboxId && state.currentTab === 'webmail') {
      try {
        const res = await fetchWithAuth(`/api/mailboxes/${state.activeMailboxId}/emails?folder=${state.activeFolder}`);
        if (res.ok) {
          const freshEmails = await res.json();
          if (freshEmails.length !== state.emails.length || (freshEmails[0]?.id !== state.emails[0]?.id)) {
            state.emails = freshEmails;
            renderEmailList();
          }
        }
      } catch {
        // Silent catch
      }
    }
  }, 8000);
});

// Real-Time Server-Sent Events (SSE) — Mailbox Scoped
let activeEventSource = null;

function setupSSE() {
  if (activeEventSource) {
    activeEventSource.close();
  }

  const url = state.activeMailboxId 
    ? `/api/events?mailboxId=${state.activeMailboxId}` 
    : '/api/events';

  activeEventSource = new EventSource(url);

  activeEventSource.addEventListener('new_email', (e) => {
    const data = JSON.parse(e.data);
    console.log('⚡ [SSE] Inbound Email Received:', data);

    if (Number(data.mailboxId) === Number(state.activeMailboxId)) {
      if (state.activeFolder === 'inbox') {
        // Prevent duplicate cards if already in array
        if (!state.emails.some(item => item.id === data.email.id)) {
          state.emails.unshift(data.email);
          renderEmailList();
        }
      }
      updateFolderBadge();
    }
    reloadLogs();
  });

  activeEventSource.addEventListener('domain_created', () => {
    loadDomains();
  });

  activeEventSource.addEventListener('mailbox_created', () => {
    loadMailboxes();
  });
}

// TAB SWITCHING
window.switchMainTab = function(tabName) {
  state.currentTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.view-panel').forEach(panel => panel.classList.remove('active'));

  const btn = document.getElementById(`tab-${tabName}-btn`);
  const panel = document.getElementById(`view-${tabName}`);
  if (btn) btn.classList.add('active');
  if (panel) panel.classList.add('active');

  if (tabName === 'domains') loadDomains();
  if (tabName === 'mailboxes') loadMailboxes();
  if (tabName === 'logs') reloadLogs();
};

// MAILBOXES & DOMAINS
async function loadMailboxes() {
  try {
    const res = await fetch('/api/mailboxes');
    state.mailboxes = await res.json();

    const select = document.getElementById('active-mailbox-select');
    select.innerHTML = '';

    if (state.mailboxes.length === 0) {
      select.innerHTML = '<option value="">No mailboxes created</option>';
      return;
    }

    state.mailboxes.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name} (${m.email})`;
      select.appendChild(opt);
    });

    if (!state.activeMailboxId || !state.mailboxes.some(m => m.id === state.activeMailboxId)) {
      state.activeMailboxId = state.mailboxes[0].id;
    }
    select.value = state.activeMailboxId;

    const activeM = state.mailboxes.find(m => m.id === state.activeMailboxId);
    if (activeM) {
      document.getElementById('sidebar-active-email').textContent = activeM.email;
      document.getElementById('compose-from').value = `${activeM.name} <${activeM.email}>`;
    }

    renderMailboxesTable();
    updateFolderBadge();
  } catch (err) {
    console.error('Failed to load mailboxes:', err);
  }
}

window.onMailboxChange = function(newId) {
  state.activeMailboxId = Number(newId);
  const activeM = state.mailboxes.find(m => m.id === state.activeMailboxId);
  if (activeM) {
    document.getElementById('sidebar-active-email').textContent = activeM.email;
    document.getElementById('compose-from').value = `${activeM.name} <${activeM.email}>`;
  }
  state.selectedEmailId = null;
  resetEmailReader();
  setupSSE(); // Reconnect SSE with new mailbox scope
  reloadEmails();
  updateFolderBadge();
};

// FOLDERS & EMAILS
window.switchFolder = function(folder) {
  state.activeFolder = folder;
  document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('active'));
  const btn = document.querySelector(`.folder-item[data-folder="${folder}"]`);
  if (btn) btn.classList.add('active');

  state.selectedEmailId = null;
  resetEmailReader();
  reloadEmails();
};

window.reloadEmails = async function() {
  if (!state.activeMailboxId) {
    await loadMailboxes();
    if (!state.activeMailboxId) return;
  }
  try {
    const res = await fetchWithAuth(`/api/mailboxes/${state.activeMailboxId}/emails?folder=${state.activeFolder}`);
    if (res.status === 403 || res.status === 401) {
      console.warn('Mailbox access unauthorized');
      return;
    }
    state.emails = await res.json();
    renderEmailList();
  } catch (err) {
    console.error('Failed to load emails:', err);
  }
};

function renderEmailList() {
  const container = document.getElementById('email-items-container');
  container.innerHTML = '';

  if (state.emails.length === 0) {
    container.innerHTML = `
      <div style="padding: 40px 20px; text-align: center; color: var(--text-dim);">
        <p>No messages in ${state.activeFolder}</p>
      </div>
    `;
    return;
  }

  state.emails.forEach(email => {
    const card = document.createElement('div');
    card.className = `email-card ${email.is_read ? '' : 'unread'} ${state.selectedEmailId === email.id ? 'active' : ''}`;
    card.onclick = () => selectEmail(email.id);

    const dateStr = formatDate(email.created_at);
    const snippet = (email.body_text || '').replace(/\s+/g, ' ').slice(0, 80);

    card.innerHTML = `
      <div class="card-top-row">
        <span class="card-sender">
          ${email.is_read ? '' : '<span class="unread-dot"></span>'}
          ${escapeHtml(email.from_name || email.from_address)}
        </span>
        <span class="card-time">${dateStr}</span>
      </div>
      <div class="card-subject">${escapeHtml(email.subject || '(No Subject)')}</div>
      <div class="card-snippet">${escapeHtml(snippet)}</div>
    `;

    container.appendChild(card);
  });
}

window.selectEmail = async function(emailId) {
  state.selectedEmailId = emailId;
  renderEmailList();

  try {
    const res = await fetchWithAuth(`/api/emails/${emailId}`);
    if (res.status === 404 || res.status === 403) {
      alert('Access denied or message no longer available.');
      return;
    }
    const email = await res.json();

    document.getElementById('email-empty-state').classList.add('hidden');
    const reader = document.getElementById('email-reader-content');
    reader.classList.remove('hidden');

    document.getElementById('reader-subject').textContent = email.subject || '(No Subject)';
    document.getElementById('reader-from-name').textContent = email.from_name || email.from_address;
    document.getElementById('reader-from-addr').textContent = `<${email.from_address}>`;
    document.getElementById('reader-to-addr').textContent = email.to_address;
    document.getElementById('reader-date').textContent = new Date(email.created_at).toLocaleString();
    document.getElementById('reader-avatar').textContent = (email.from_name || email.from_address)[0].toUpperCase();

    // Render HTML in sandboxed iframe
    const iframe = document.getElementById('reader-html-frame');
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1e293b; padding: 16px; margin: 0; line-height: 1.6; }
            a { color: #0284c7; }
            pre { background: #f1f5f9; padding: 12px; border-radius: 6px; overflow-x: auto; }
          </style>
        </head>
        <body>${email.body_html || `<pre>${escapeHtml(email.body_text)}</pre>`}</body>
      </html>
    `);
    doc.close();

    // Attachments
    const attStrip = document.getElementById('reader-attachments-strip');
    const attList = document.getElementById('reader-attachments-list');
    if (email.attachments && email.attachments.length > 0) {
      attStrip.classList.remove('hidden');
      attList.innerHTML = '';
      email.attachments.forEach(att => {
        const chip = document.createElement('a');
        chip.className = 'attachment-chip';
        chip.href = `data:${att.content_type};base64,${att.data_base64}`;
        chip.download = att.filename;
        chip.innerHTML = `📎 ${escapeHtml(att.filename)} (${Math.round(att.size / 1024)} KB)`;
        attList.appendChild(chip);
      });
    } else {
      attStrip.classList.add('hidden');
    }

    // Mark as read automatically
    if (!email.is_read) {
      await fetchWithAuth(`/api/emails/${emailId}/mark-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isRead: true })
      });
      email.is_read = 1;
      const target = state.emails.find(e => e.id === emailId);
      if (target) target.is_read = 1;
      renderEmailList();
      updateFolderBadge();
    }
  } catch (err) {
    console.error('Failed to view email:', err);
  }
};

function resetEmailReader() {
  document.getElementById('email-empty-state').classList.remove('hidden');
  document.getElementById('email-reader-content').classList.add('hidden');
}

window.deleteCurrent = async function() {
  if (!state.selectedEmailId) return;
  if (!confirm('Are you sure you want to delete this email?')) return;

  try {
    const res = await fetchWithAuth(`/api/emails/${state.selectedEmailId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.selectedEmailId = null;
    resetEmailReader();
    await reloadEmails();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
};

window.replyCurrent = function() {
  const email = state.emails.find(e => e.id === state.selectedEmailId);
  if (!email) return;

  openComposeModal();
  document.getElementById('compose-to').value = email.from_address;
  document.getElementById('compose-subject').value = `Re: ${email.subject || ''}`;
  document.getElementById('compose-body').value = `\n\n--- On ${new Date(email.created_at).toLocaleString()}, ${email.from_address} wrote:\n> ${(email.body_text || '').replace(/\n/g, '\n> ')}`;
};

window.filterEmails = function(query) {
  const term = query.toLowerCase().trim();
  const filtered = state.emails.filter(e => 
    (e.subject || '').toLowerCase().includes(term) ||
    (e.from_address || '').toLowerCase().includes(term) ||
    (e.from_name || '').toLowerCase().includes(term) ||
    (e.body_text || '').toLowerCase().includes(term)
  );

  const container = document.getElementById('email-items-container');
  container.innerHTML = '';
  filtered.forEach(email => {
    const card = document.createElement('div');
    card.className = `email-card ${email.is_read ? '' : 'unread'} ${state.selectedEmailId === email.id ? 'active' : ''}`;
    card.onclick = () => selectEmail(email.id);
    card.innerHTML = `
      <div class="card-top-row">
        <span class="card-sender">${escapeHtml(email.from_name || email.from_address)}</span>
        <span class="card-time">${formatDate(email.created_at)}</span>
      </div>
      <div class="card-subject">${escapeHtml(email.subject || '(No Subject)')}</div>
    `;
    container.appendChild(card);
  });
};

function updateFolderBadge() {
  const badge = document.getElementById('inbox-badge');
  const count = state.emails.filter(e => !e.is_read && e.folder === 'inbox').length;
  badge.textContent = count > 0 ? count : '';
}

// DOMAINS VIEW
let isLoadingDomains = false;
async function loadDomains() {
  if (isLoadingDomains) return;
  isLoadingDomains = true;
  try {
    const res = await fetch('/api/domains');
    state.domains = await res.json();
    const grid = document.getElementById('domains-grid');
    grid.innerHTML = '';

    for (const d of state.domains) {
      const dnsRes = await fetch(`/api/domains/${d.id}/dns`);
      const { dnsRecords } = await dnsRes.json();

      const card = document.createElement('div');
      card.className = 'domain-card';
      card.innerHTML = `
        <div class="domain-card-header">
          <div>
            <span class="domain-name">${escapeHtml(d.name)}</span>
            <span class="sec-badge sec-pass" style="margin-left: 10px;">${d.status.toUpperCase()}</span>
          </div>
          <span style="font-size: 0.8rem; color: var(--text-dim);">${d.mailbox_count || 0} Mailboxes Connected</span>
        </div>
        <div class="dns-table-wrap">
          <table class="dns-records-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Host / Name</th>
                <th>Value / Target</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${dnsRecords.map(r => `
                <tr>
                  <td><span class="record-type-badge">${r.type}</span></td>
                  <td><code>${r.name}</code></td>
                  <td>
                    <span class="record-val-code" title="${escapeHtml(r.value)}">
                      ${r.priority ? `[Priority: ${r.priority}] ` : ''}${escapeHtml(r.value)}
                    </span>
                  </td>
                  <td>
                    <button class="copy-btn" onclick="copyText('${escapeHtml(r.value)}')">Copy</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
      grid.appendChild(card);
    }
  } catch (err) {
    console.error('Failed to load domains:', err);
  } finally {
    isLoadingDomains = false;
  }
}

// MAILBOXES TABLE
function renderMailboxesTable() {
  const tbody = document.getElementById('mailboxes-table-body');
  tbody.innerHTML = '';

  state.mailboxes.forEach(m => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(m.email)}</strong></td>
      <td>${escapeHtml(m.name)}</td>
      <td>${escapeHtml(m.domain_name)}</td>
      <td>${m.quota_mb} MB</td>
      <td>${new Date(m.created_at).toLocaleDateString()}</td>
      <td>
        <button class="btn-secondary" style="padding: 4px 10px; font-size: 0.75rem;" onclick="onMailboxChange(${m.id}); switchMainTab('webmail');">Open Webmail</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// LOGS
window.reloadLogs = async function() {
  try {
    const res = await fetch('/api/smtp-logs?limit=50');
    state.logs = await res.json();
    const container = document.getElementById('console-logs-list');
    container.innerHTML = '';

    if (state.logs.length === 0) {
      container.innerHTML = '<div style="color: var(--text-dim);">No logs captured yet.</div>';
      return;
    }

    state.logs.forEach(l => {
      const row = document.createElement('div');
      row.className = 'log-entry';
      const time = new Date(l.created_at).toLocaleTimeString();
      row.innerHTML = `
        <span class="log-time">[${time}]</span>
        <span class="log-type ${l.status}">${l.type}</span>
        <span class="log-details">${escapeHtml(l.details || `${l.sender} -> ${l.recipient}`)}</span>
      `;
      container.appendChild(row);
    });
  } catch (err) {
    console.error('Failed to reload logs:', err);
  }
};

// COMPOSE MODAL
window.openComposeModal = function() {
  document.getElementById('compose-modal').classList.remove('hidden');
};

window.closeComposeModal = function() {
  document.getElementById('compose-modal').classList.add('hidden');
  document.getElementById('compose-to').value = '';
  document.getElementById('compose-subject').value = '';
  document.getElementById('compose-body').value = '';
};

window.handleSendEmail = async function(e) {
  e.preventDefault();
  const activeM = state.mailboxes.find(m => m.id === state.activeMailboxId);
  if (!activeM) return alert('No active mailbox selected');

  const toEmail = document.getElementById('compose-to').value.trim();
  const subject = document.getElementById('compose-subject').value.trim();
  const body = document.getElementById('compose-body').value;

  const btn = document.getElementById('send-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Transmitting with DKIM...';

  try {
    const res = await fetchWithAuth('/api/emails/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromEmail: activeM.email,
        toEmail: toEmail,
        subject: subject,
        bodyText: body
      })
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (data.mode === 'internal') {
      alert(`Delivered locally to ${toEmail} with internal signature!`);
    } else if (data.mode === 'external_mx_delivered') {
      alert(`Success! Email delivered to remote MX (${data.mxHost}) with 2048-bit DKIM signature!\nRemote Response: ${data.response}`);
    } else if (data.mode === 'external_mx_attempted') {
      alert(`Outbound Attempted to MX: ${data.mxHost}\n\nNotice: ${data.error}\n\nDiagnostic: ${data.diagnostic}`);
    }

    closeComposeModal();
    if (state.activeFolder === 'sent') reloadEmails();
    reloadLogs();
  } catch (err) {
    alert('Send failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Email';
  }
};

// ADD DOMAIN MODAL
window.openAddDomainModal = function() {
  document.getElementById('add-domain-modal').classList.remove('hidden');
};

window.closeAddDomainModal = function() {
  document.getElementById('add-domain-modal').classList.add('hidden');
  document.getElementById('new-domain-name').value = '';
};

window.handleAddDomain = async function(e) {
  e.preventDefault();
  const name = document.getElementById('new-domain-name').value.trim();
  try {
    const res = await fetch('/api/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    closeAddDomainModal();
    await loadDomains();
    alert(`Domain "${name}" connected and 2048-bit DKIM keys generated!`);
  } catch (err) {
    alert('Error adding domain: ' + err.message);
  }
};

// ADD MAILBOX MODAL
window.openAddMailboxModal = function() {
  const select = document.getElementById('new-mailbox-domain');
  select.innerHTML = '';
  state.domains.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    select.appendChild(opt);
  });
  document.getElementById('add-mailbox-modal').classList.remove('hidden');
};

window.closeAddMailboxModal = function() {
  document.getElementById('add-mailbox-modal').classList.add('hidden');
  document.getElementById('new-mailbox-username').value = '';
  document.getElementById('new-mailbox-name').value = '';
  const pwd = document.getElementById('new-mailbox-password');
  if (pwd) pwd.value = '';
};

window.handleAddMailbox = async function(e) {
  e.preventDefault();
  const domainId = document.getElementById('new-mailbox-domain').value;
  const username = document.getElementById('new-mailbox-username').value.trim();
  const displayName = document.getElementById('new-mailbox-name').value.trim();
  const password = document.getElementById('new-mailbox-password').value;

  const domain = state.domains.find(d => d.id === Number(domainId));
  if (!domain) return alert('Domain not found');

  const fullEmail = `${username}@${domain.name}`.toLowerCase();

  try {
    const res = await fetch('/api/mailboxes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domainId: domain.id,
        email: fullEmail,
        name: displayName,
        password: password
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    closeAddMailboxModal();
    await loadMailboxes();
    alert(`Mailbox "${fullEmail}" created securely!`);
  } catch (err) {
    alert('Error creating mailbox: ' + err.message);
  }
};

// UTILITIES
window.copyText = function(text) {
  navigator.clipboard.writeText(text).then(() => {
    alert('Copied to clipboard!');
  });
};

function formatDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function escapeHtml(string) {
  return String(string)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
