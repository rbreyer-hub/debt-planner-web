/* ── Storage ─────────────────────────────────────────────── */
const STORAGE_KEY = 'debtPlannerData';
const DEBT_COLOR_VALUES = ['#4fd1a0','#60a8f0','#f0c060','#f07070','#c060f0','#f09060','#60d0f0','#90f070'];
function colorValue(idx) { return DEBT_COLOR_VALUES[idx % DEBT_COLOR_VALUES.length]; }

/* Experian report snapshot — Jun 2026. APR + due day left blank for user to fill in. */
window.EXPERIAN_SEED_DEBTS_IDS = ['seed01','seed02','seed03','seed04','seed05','seed06','seed07','seed08','seed09','seed10','seed11'];
window.applySeedMerge = function(jsonStr) {
  try {
    const parsed = JSON.parse(jsonStr);
    const existing = parsed.debts || [];
    const existingIds = new Set(existing.map(x => x.id));
    const missing = EXPERIAN_SEED_DEBTS.filter(s => !existingIds.has(s.id)).map(s => Object.assign({}, s));
    if (missing.length === 0) return jsonStr;
    return JSON.stringify(Object.assign({}, parsed, { debts: [...existing, ...missing] }));
  } catch (_) { return jsonStr; }
};
const EXPERIAN_SEED_DEBTS = [
  { id:'seed01', name:'Affirm (BNPL #1)',         type:'other',         balance:58,     limit:0,     apr:0, minPayment:42,   dueDay:0 },
  { id:'seed02', name:'Affirm (BNPL #2)',         type:'other',         balance:99,     limit:0,     apr:0, minPayment:25,   dueDay:0 },
  { id:'seed03', name:'Capital One',              type:'credit_card',   balance:1764,   limit:2000,  apr:0, minPayment:39,   dueDay:0 },
  { id:'seed04', name:'Chime Secured Card',       type:'credit_card',   balance:245,    limit:0,     apr:0, minPayment:0,    dueDay:0 },
  { id:'seed05', name:'Citi',                     type:'credit_card',   balance:3731,   limit:4000,  apr:0, minPayment:103,  dueDay:0 },
  { id:'seed06', name:'Citi (authorized user)',   type:'credit_card',   balance:6752,   limit:7010,  apr:0, minPayment:197,  dueDay:0 },
  { id:'seed07', name:'Columbia Bank (Mortgage)', type:'other',         balance:342005, limit:0,     apr:0, minPayment:1997, dueDay:0 },
  { id:'seed08', name:'Idaho Central CU',         type:'personal_loan', balance:17336,  limit:0,     apr:0, minPayment:438,  dueDay:0 },
  { id:'seed09', name:'JPMCB Card (auth user)',   type:'credit_card',   balance:9561,   limit:13300, apr:0, minPayment:278,  dueDay:0 },
  { id:'seed10', name:'SYNCB / Networking',       type:'credit_card',   balance:1196,   limit:1350,  apr:0, minPayment:42,   dueDay:0 },
  { id:'seed11', name:'SYNCB / Venmo',            type:'credit_card',   balance:404,    limit:640,   apr:0, minPayment:41,   dueDay:0 },
];

let state = {
  debts: [],
  strategy: 'snowball',
  extraPayment: 0,
  creditScore: null,
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(),
  scheduleDebtId: 'all'
};

function save() {
  const toSave = { debts: state.debts, strategy: state.strategy, extraPayment: state.extraPayment, creditScore: state.creditScore };
  const json = JSON.stringify(toSave);
  localStorage.setItem(STORAGE_KEY, json);
  window.cloudSync?.save(json);
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      state.debts       = EXPERIAN_SEED_DEBTS.map(d => Object.assign({}, d));
      state.creditScore = 673;
      save();
      return;
    }
    const d = JSON.parse(raw);
    const existing = d.debts || [];
    const existingIds = new Set(existing.map(x => x.id));
    const missing = EXPERIAN_SEED_DEBTS.filter(s => !existingIds.has(s.id)).map(s => Object.assign({}, s));
    state.debts = [...existing, ...missing];
    state.strategy = d.strategy || 'snowball';
    state.extraPayment = d.extraPayment || 0;
    state.creditScore = d.creditScore || 673;
    if (missing.length > 0) save();
  } catch (e) { /* ignore */ }
}

/* ── Utilities ───────────────────────────────────────────── */
function fmt(n) {
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtMonth(m) {
  if (m === 1) return '1 month';
  if (m < 12) return m + ' months';
  const y = Math.floor(m / 12), mo = m % 12;
  return y + 'yr' + (mo ? ' ' + mo + 'mo' : '');
}
function uid() { return Math.random().toString(36).slice(2, 10); }


/* ── Core calculations ───────────────────────────────────── */
function totalBalance() { return state.debts.reduce((s, d) => s + d.balance, 0); }
function totalMinPayment() { return state.debts.reduce((s, d) => s + d.minPayment, 0); }
function totalLimit() { return state.debts.filter(d => d.limit > 0).reduce((s, d) => s + d.limit, 0); }
function totalUtilization() {
  const lim = totalLimit();
  if (!lim) return null;
  const bal = state.debts.filter(d => d.limit > 0).reduce((s, d) => s + d.balance, 0);
  return (bal / lim) * 100;
}

function calcPayoffSchedule(debtsInput, extraPayment, strategy) {
  if (!debtsInput.length) return { payoffOrder: [], totalMonths: 0, totalInterest: 0 };

  let debts = debtsInput.map(d => ({ ...d }));

  if (strategy === 'snowball') {
    debts.sort((a, b) => a.balance - b.balance);
  } else {
    debts.sort((a, b) => b.apr - a.apr);
  }

  const startBalances = {};
  debts.forEach(d => startBalances[d.id] = d.balance);

  const payoffOrder = [];
  let month = 0;
  let rolledOver = 0;
  let totalInterest = 0;
  const paidIds = new Set();

  while (debts.some(d => d.balance > 0.005) && month < 600) {
    month++;
    const priorityIdx = debts.findIndex(d => d.balance > 0.005);

    for (let i = 0; i < debts.length; i++) {
      const d = debts[i];
      if (d.balance <= 0.005) { d.balance = 0; continue; }

      const monthlyRate = d.apr / 100 / 12;
      const interest = d.balance * monthlyRate;
      totalInterest += interest;
      d.balance += interest;

      let payment;
      if (i === priorityIdx) {
        payment = Math.min(d.minPayment + extraPayment + rolledOver, d.balance);
      } else {
        payment = Math.min(d.minPayment, d.balance);
      }

      d.balance = Math.max(0, d.balance - payment);

      if (d.balance < 0.005 && !paidIds.has(d.id)) {
        d.balance = 0;
        paidIds.add(d.id);
        payoffOrder.push({ id: d.id, name: d.name, month, startBalance: startBalances[d.id], order: payoffOrder.length + 1 });
        rolledOver += d.minPayment;
      }
    }
  }

  return { payoffOrder, totalMonths: month, totalInterest };
}

function calcAmortization(debt, extraPayment = 0) {
  const rows = [];
  let balance = debt.balance;
  let month = 0;
  const monthlyRate = debt.apr / 100 / 12;
  let totalInterest = 0;

  while (balance > 0.005 && month < 600) {
    month++;
    const interest = balance * monthlyRate;
    totalInterest += interest;
    balance += interest;
    const payment = Math.min(debt.minPayment + extraPayment, balance);
    const principal = payment - interest;
    balance = Math.max(0, balance - payment);

    rows.push({ month, payment, principal, interest, balance, totalInterest });
  }
  return rows;
}

function calcSavingsProjection(monthlyFreed, months) {
  const rates = [0.04, 0.06, 0.08];
  return rates.map(r => {
    let total = 0;
    for (let m = 0; m < months; m++) {
      total = total * (1 + r / 12) + monthlyFreed;
    }
    return { rate: r * 100, total };
  });
}

/* ── Tab routing ─────────────────────────────────────────── */
let activeTab = 'overview';

function switchTab(id) {
  activeTab = id;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + id));
  renderActiveTab();
}

function renderActiveTab() {
  switch (activeTab) {
    case 'overview':  renderOverview(); break;
    case 'debts':     renderDebts(); break;
    case 'strategy':  renderStrategy(); break;
    case 'schedule':  renderSchedule(); break;
    case 'calendar':  renderCalendar(); break;
    case 'credit':    renderCredit(); break;
  }
}

/* ── Overview ────────────────────────────────────────────── */
function renderOverview() {
  const pane = document.getElementById('pane-overview');
  const total = totalBalance();
  const minPay = totalMinPayment();
  const { payoffOrder, totalMonths, totalInterest } = calcPayoffSchedule(state.debts, state.extraPayment, state.strategy);
  const util = totalUtilization();

  const strategyLabel = state.strategy === 'snowball' ? 'Snowball' : 'Avalanche';

  let nextDue = null;
  const today = new Date();
  state.debts.forEach(d => {
    if (!d.dueDay) return;
    let due = new Date(today.getFullYear(), today.getMonth(), d.dueDay);
    if (due < today) due = new Date(today.getFullYear(), today.getMonth() + 1, d.dueDay);
    if (!nextDue || due < nextDue.date) nextDue = { date: due, name: d.name, amount: d.minPayment };
  });

  const paidOff = payoffOrder.length > 0 ? payoffOrder[payoffOrder.length - 1] : null;

  pane.innerHTML = `
    ${state.debts.length === 0 ? `
      <div class="empty-state">
        <div class="empty-icon">💳</div>
        <div class="empty-title">No debts added yet</div>
        <p>Add your credit cards and loans to get started.</p>
        <br>
        <button class="btn btn-primary" onclick="switchTab('debts')">+ Add your first debt</button>
      </div>
    ` : `
      <h2 class="section-title">Overview</h2>
      <p class="section-sub">Your complete debt picture at a glance.</p>

      <div class="card-grid">
        <div class="stat-card">
          <div class="stat-label">Total Debt</div>
          <div class="stat-value danger">${fmt(total)}</div>
          <div class="stat-sub">${state.debts.length} account${state.debts.length !== 1 ? 's' : ''}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Min Monthly Payment</div>
          <div class="stat-value">${fmt(minPay)}</div>
          <div class="stat-sub">across all debts</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Payoff Time (${strategyLabel})</div>
          <div class="stat-value ${totalMonths > 0 ? 'warn' : 'good'}">${totalMonths > 0 ? fmtMonth(totalMonths) : '—'}</div>
          <div class="stat-sub">${state.extraPayment > 0 ? fmt(state.extraPayment) + '/mo extra' : 'minimums only'}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Total Interest</div>
          <div class="stat-value danger">${fmt(totalInterest)}</div>
          <div class="stat-sub">if paid as scheduled</div>
        </div>
        ${util !== null ? `
        <div class="stat-card">
          <div class="stat-label">Credit Utilization</div>
          <div class="stat-value ${util < 10 ? 'good' : util < 30 ? 'warn' : 'danger'}">${util.toFixed(1)}%</div>
          <div class="stat-sub">${util < 10 ? 'Excellent' : util < 30 ? 'Good — aim for <30%' : 'High — aim for <30%'}</div>
        </div>
        ` : ''}
        ${nextDue ? `
        <div class="stat-card">
          <div class="stat-label">Next Payment Due</div>
          <div class="stat-value" style="font-size:1.2rem">${nextDue.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
          <div class="stat-sub">${nextDue.name} — ${fmt(nextDue.amount)}</div>
        </div>
        ` : ''}
      </div>

      ${state.debts.length > 0 ? `
      <div class="card">
        <h2 style="margin-bottom:14px">Debt Progress</h2>
        ${state.debts.map((d, i) => {
          const orig = Math.max(d.balance, d.originalBalance || d.balance);
          const pct = Math.min(100, ((orig - d.balance) / orig) * 100);
          return `
          <div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <span style="font-size:0.88rem;font-weight:600">${d.name}</span>
              <span style="font-size:0.85rem;color:var(--muted)">${fmt(d.balance)} <span style="color:var(--muted-2);font-size:0.78rem">@ ${d.apr}% APR</span></span>
            </div>
            <div class="progress-wrap">
              <div class="progress-bar ${colorValue(i)}" style="width:${pct}%;background:var(--accent)"></div>
            </div>
          </div>`;
        }).join('')}
      </div>
      ` : ''}

      ${paidOff && totalMonths > 0 ? `
      <div class="savings-projection">
        <h3>🎉 What if you saved those payments after payoff?</h3>
        <p style="font-size:0.85rem;color:var(--muted)">
          After ${fmtMonth(totalMonths)}, you'll free up ${fmt(minPay + state.extraPayment)}/mo.
          Here's what that could grow to investing it:
        </p>
        <div class="savings-grid">
          ${calcSavingsProjection(minPay + state.extraPayment, 60).map(s => `
            <div class="savings-item">
              <div class="val">${fmt(s.total)}</div>
              <div class="lbl">${s.rate}% return · 5 yrs</div>
            </div>
          `).join('')}
          ${calcSavingsProjection(minPay + state.extraPayment, 120).map(s => `
            <div class="savings-item">
              <div class="val">${fmt(s.total)}</div>
              <div class="lbl">${s.rate}% return · 10 yrs</div>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}
    `}
  `;
}

/* ── Debts tab ───────────────────────────────────────────── */
function renderDebts() {
  const pane = document.getElementById('pane-debts');
  pane.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px">
      <div>
        <h2 class="section-title">My Debts</h2>
        <p class="section-sub" style="margin:0">Track all your credit cards, loans, and lines of credit.</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${state.debts.some(d => d.id && d.id.startsWith('seed')) ? '' : `<button class="btn" style="background:var(--surface-2);color:var(--text)" onclick="importExperianDebts()">Import Experian Debts</button>`}
        <button class="btn btn-primary" onclick="openDebtModal()">+ Add Debt</button>
      </div>
    </div>

    ${state.debts.length === 0 ? `
      <div class="empty-state">
        <div class="empty-icon">💳</div>
        <div class="empty-title">No debts added yet</div>
        <p>Add a credit card or loan to start planning your payoff.</p>
      </div>
    ` : `
      <div class="debt-list">
        ${state.debts.map((d, i) => {
          const util = d.limit > 0 ? (d.balance / d.limit) * 100 : null;
          const utilClass = util === null ? '' : util < 10 ? 'util-good' : util < 30 ? 'util-warn' : 'util-bad';
          const utilLabel = util === null ? '' : util.toFixed(0) + '% used';
          return `
          <div class="debt-item">
            <div class="debt-color-bar" style="background:${colorValue(i)}"></div>
            <div class="debt-info">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <span class="debt-name">${d.name}</span>
                <span style="font-size:0.75rem;color:var(--muted);background:var(--surface-2);padding:2px 8px;border-radius:99px">${d.type.replace('_',' ')}</span>
                ${util !== null ? `<span class="debt-utilization ${utilClass}">${utilLabel}</span>` : ''}
              </div>
              <div class="debt-meta">
                <span>APR: <strong style="color:var(--text)">${d.apr}%</strong></span>
                <span>Min: <strong style="color:var(--text)">${fmt(d.minPayment)}/mo</strong></span>
                ${d.dueDay ? `<span>Due: <strong style="color:var(--text)">Day ${d.dueDay}</strong></span>` : ''}
                ${d.limit > 0 ? `<span>Limit: <strong style="color:var(--text)">${fmt(d.limit)}</strong></span>` : ''}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
              <span class="debt-balance">${fmt(d.balance)}</span>
              <div class="debt-actions">
                <button class="btn-icon" title="Edit" onclick="openDebtModal('${d.id}')">✏️</button>
                <button class="btn-icon danger" title="Delete" onclick="deleteDebt('${d.id}')">🗑️</button>
              </div>
            </div>
          </div>
          `;
        }).join('')}
      </div>

      <div class="card" style="margin-top:20px;display:flex;flex-wrap:wrap;gap:20px;justify-content:space-between;align-items:center">
        <div>
          <span style="font-size:0.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Total Balance</span>
          <div style="font-size:1.6rem;font-weight:700;color:var(--red)">${fmt(totalBalance())}</div>
        </div>
        <div>
          <span style="font-size:0.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Monthly Minimums</span>
          <div style="font-size:1.6rem;font-weight:700">${fmt(totalMinPayment())}</div>
        </div>
        ${totalUtilization() !== null ? `
        <div>
          <span style="font-size:0.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">Overall Utilization</span>
          <div style="font-size:1.6rem;font-weight:700;color:${totalUtilization() < 30 ? 'var(--accent)' : 'var(--red)'}">${totalUtilization().toFixed(1)}%</div>
        </div>
        ` : ''}
      </div>
    `}
  `;
}

/* ── Strategy tab ────────────────────────────────────────── */
function renderStrategy() {
  const pane = document.getElementById('pane-strategy');
  const { payoffOrder: snowOrder, totalMonths: snowMonths, totalInterest: snowInt } = calcPayoffSchedule(state.debts, state.extraPayment, 'snowball');
  const { payoffOrder: avaOrder, totalMonths: avaMonths, totalInterest: avaInt } = calcPayoffSchedule(state.debts, state.extraPayment, 'avalanche');

  const currentOrder = state.strategy === 'snowball' ? snowOrder : avaOrder;
  const currentMonths = state.strategy === 'snowball' ? snowMonths : avaMonths;
  const currentInt = state.strategy === 'snowball' ? snowInt : avaInt;

  pane.innerHTML = `
    <h2 class="section-title">Payoff Strategy</h2>
    <p class="section-sub">Choose your method and see your personalized payoff roadmap.</p>

    <div class="strategy-toggle">
      <button class="strategy-btn ${state.strategy === 'snowball' ? 'active' : ''}" onclick="setStrategy('snowball')">
        <div class="s-title">❄️ Debt Snowball</div>
        <div class="s-desc">Pay off smallest balance first. Quick wins keep you motivated.${snowMonths > 0 ? ' <strong>'+fmtMonth(snowMonths)+'</strong>' : ''}</div>
      </button>
      <button class="strategy-btn ${state.strategy === 'avalanche' ? 'active' : ''}" onclick="setStrategy('avalanche')">
        <div class="s-title">🏔️ Debt Avalanche</div>
        <div class="s-desc">Pay off highest APR first. Saves the most interest.${avaMonths > 0 ? ' <strong>'+fmtMonth(avaMonths)+'</strong>' : ''}</div>
      </button>
    </div>

    ${avaMonths > 0 && snowMonths > 0 ? `
    <div class="card" style="margin-bottom:20px;display:flex;flex-wrap:wrap;gap:20px">
      <div>
        <span style="font-size:0.78rem;color:var(--muted)">Interest saved with Avalanche vs Snowball</span>
        <div style="font-size:1.3rem;font-weight:700;color:var(--accent)">${fmt(Math.max(0, snowInt - avaInt))}</div>
      </div>
      <div>
        <span style="font-size:0.78rem;color:var(--muted)">Time difference</span>
        <div style="font-size:1.3rem;font-weight:700;color:var(--yellow)">${Math.abs(snowMonths - avaMonths)} months</div>
      </div>
    </div>
    ` : ''}

    <div class="card">
      <div class="extra-input-row">
        <div class="form-group">
          <label>Extra monthly payment ($)</label>
          <input type="number" id="extraPayInput" min="0" step="10" value="${state.extraPayment}" placeholder="0.00" />
        </div>
        <button class="btn btn-primary" onclick="applyExtra()">Apply</button>
      </div>
      ${state.extraPayment > 0 ? `
        <p style="font-size:0.83rem;color:var(--accent);margin-top:-8px">
          ✓ ${fmt(state.extraPayment)}/mo extra applied to ${state.strategy === 'snowball' ? 'smallest' : 'highest-APR'} debt
        </p>
      ` : `
        <p style="font-size:0.83rem;color:var(--muted);margin-top:-8px">
          Even $50–$100 extra per month can save thousands in interest.
        </p>
      `}
    </div>

    ${currentOrder.length === 0 ? `
      <div class="empty-state">
        <div class="empty-icon">🎯</div>
        <div class="empty-title">No debts to plan</div>
        <p>Add debts in the My Debts tab first.</p>
      </div>
    ` : `
      <div class="card" style="margin-top:16px">
        <h2 style="margin-bottom:4px">Payoff Order</h2>
        <p style="font-size:0.83rem;color:var(--muted);margin-bottom:16px">
          ${state.strategy === 'snowball' ? 'Smallest balance first — roll each minimum payment forward.' : 'Highest APR first — minimizes total interest paid.'}
          Total: <strong>${fmtMonth(currentMonths)}</strong> · <strong>${fmt(currentInt)}</strong> in interest
        </p>
        <div class="payoff-timeline">
          ${currentOrder.map(item => {
            const debtObj = state.debts.find(d => d.id === item.id);
            return `
            <div class="payoff-row">
              <div class="payoff-num done">${item.order}</div>
              <div class="payoff-detail">
                <span class="payoff-name">${item.name}</span>
                <span class="payoff-meta">${debtObj ? debtObj.apr + '% APR · min ' + fmt(debtObj.minPayment) : ''}</span>
              </div>
              <div class="payoff-bal">
                <div class="amount">${fmt(item.startBalance)}</div>
                <div class="month">paid off ${fmtMonth(item.month)}</div>
              </div>
            </div>
            `;
          }).join('')}
        </div>
      </div>

      <div class="savings-projection" style="margin-top:16px">
        <h3>💰 After all debts are paid off…</h3>
        <p style="font-size:0.85rem;color:var(--muted)">
          Redirect your ${fmt(totalMinPayment() + state.extraPayment)}/mo into savings or investments:
        </p>
        <div class="savings-grid">
          ${calcSavingsProjection(totalMinPayment() + state.extraPayment, 60).map(s => `
            <div class="savings-item">
              <div class="val">${fmt(s.total)}</div>
              <div class="lbl">${s.rate}% · 5 yrs</div>
            </div>
          `).join('')}
          ${calcSavingsProjection(totalMinPayment() + state.extraPayment, 120).map(s => `
            <div class="savings-item">
              <div class="val">${fmt(s.total)}</div>
              <div class="lbl">${s.rate}% · 10 yrs</div>
            </div>
          `).join('')}
        </div>
      </div>
    `}
  `;
}

/* ── Schedule tab ────────────────────────────────────────── */
function renderSchedule() {
  const pane = document.getElementById('pane-schedule');

  const debtOptions = state.debts.map(d => `<option value="${d.id}" ${state.scheduleDebtId === d.id ? 'selected' : ''}>${d.name}</option>`).join('');

  if (state.debts.length === 0) {
    pane.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><div class="empty-title">No debts to schedule</div><p>Add debts first.</p></div>`;
    return;
  }

  let rows = [];
  let debtName = '';
  let totalIntPaid = 0;

  if (state.scheduleDebtId === 'all' || !state.scheduleDebtId) {
    // Combined amortization: show month-by-month totals across all debts
    const schedule = calcPayoffSchedule(state.debts, state.extraPayment, state.strategy);
    // Build combined table from individual amortizations
    const allSchedules = state.debts.map(d => calcAmortization(d, 0));
    const maxMonths = Math.max(...allSchedules.map(s => s.length));
    for (let m = 0; m < maxMonths; m++) {
      let totPay = 0, totInt = 0, totPrin = 0, totBal = 0;
      allSchedules.forEach(s => {
        if (m < s.length) {
          totPay += s[m].payment;
          totInt += s[m].interest;
          totPrin += s[m].principal;
          totBal += s[m].balance;
        }
      });
      totalIntPaid += totInt;
      rows.push({ month: m + 1, payment: totPay, interest: totInt, principal: totPrin, balance: totBal, totalInterest: totalIntPaid });
    }
    debtName = 'All Debts (minimums only)';
  } else {
    const debt = state.debts.find(d => d.id === state.scheduleDebtId);
    if (debt) {
      rows = calcAmortization(debt, 0);
      debtName = debt.name;
    }
  }

  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now = new Date();

  pane.innerHTML = `
    <h2 class="section-title">Amortization Schedule</h2>
    <p class="section-sub">Month-by-month payment breakdown.</p>

    <div class="schedule-controls">
      <div class="form-group" style="min-width:200px">
        <label>Select debt</label>
        <select onchange="state.scheduleDebtId=this.value;renderSchedule()">
          <option value="all" ${state.scheduleDebtId === 'all' ? 'selected' : ''}>All Debts</option>
          ${debtOptions}
        </select>
      </div>
      <div style="font-size:0.83rem;color:var(--muted);padding-top:18px">
        ${rows.length} months · ${fmt(rows.reduce((s,r)=>s+r.interest,0))} total interest
      </div>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Date</th>
              <th>Payment</th>
              <th>Principal</th>
              <th>Interest</th>
              <th>Remaining Balance</th>
              <th>Cumulative Interest</th>
            </tr>
          </thead>
          <tbody>
            ${rows.slice(0, 120).map(r => {
              const d = new Date(now.getFullYear(), now.getMonth() + r.month - 1, 1);
              const label = monthNames[d.getMonth()] + ' ' + d.getFullYear();
              return `
              <tr>
                <td class="td-muted">${r.month}</td>
                <td>${label}</td>
                <td>${fmt(r.payment)}</td>
                <td class="td-green">${fmt(Math.max(0, r.principal))}</td>
                <td class="td-red">${fmt(r.interest)}</td>
                <td><strong>${fmt(r.balance)}</strong></td>
                <td class="td-muted">${fmt(r.totalInterest)}</td>
              </tr>
              `;
            }).join('')}
            ${rows.length > 120 ? `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:14px">… ${rows.length - 120} more months not shown</td></tr>` : ''}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ── Calendar tab ────────────────────────────────────────── */
function renderCalendar() {
  const pane = document.getElementById('pane-calendar');
  const year = state.calYear;
  const month = state.calMonth;
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  const today = new Date();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Map due days to debts
  const paymentsByDay = {};
  state.debts.forEach((d, i) => {
    if (!d.dueDay) return;
    const day = Math.min(d.dueDay, daysInMonth);
    if (!paymentsByDay[day]) paymentsByDay[day] = [];
    paymentsByDay[day].push({ name: d.name, amount: d.minPayment, color: colorValue(i), colorStr: colorValue(i) });
  });

  // Build calendar cells
  let cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);


  pane.innerHTML = `
    <h2 class="section-title">Payment Calendar</h2>
    <p class="section-sub">See all your payment due dates at a glance.</p>

    <div class="card">
      <div class="cal-nav">
        <button class="btn btn-ghost btn-sm" onclick="calNav(-1)">‹ Prev</button>
        <span class="cal-month-label">${monthNames[month]} ${year}</span>
        <button class="btn btn-ghost btn-sm" onclick="calNav(1)">Next ›</button>
      </div>

      <div class="cal-grid">
        ${dayNames.map(n => `<div class="cal-day-header">${n}</div>`).join('')}
        ${cells.map(day => {
          if (!day) return `<div class="cal-day empty"></div>`;
          const isToday = year === today.getFullYear() && month === today.getMonth() && day === today.getDate();
          const events = paymentsByDay[day] || [];
          return `
          <div class="cal-day ${isToday ? 'today' : ''}">
            <div class="cal-day-num">${day}</div>
            <div class="cal-events">
              ${events.map(e => `
                <div class="cal-event" style="background:${e.colorStr}22;color:${e.colorStr};border:1px solid ${e.colorStr}44" title="${e.name}: ${fmt(e.amount)}">
                  ${e.name}
                </div>
              `).join('')}
            </div>
          </div>
          `;
        }).join('')}
      </div>
    </div>

    ${state.debts.filter(d => d.dueDay).length === 0 ? `
      <div style="text-align:center;padding:20px;color:var(--muted);font-size:0.88rem">
        No due dates set. Edit your debts to add due day numbers.
      </div>
    ` : `
      <div class="card" style="margin-top:16px">
        <h2 style="margin-bottom:14px">This Month's Payments</h2>
        ${state.debts.filter(d => d.dueDay).sort((a,b) => a.dueDay - b.dueDay).map((d, i) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:8px;height:8px;border-radius:50%;background:${colorValue(i)}"></div>
              <div>
                <div style="font-weight:600">${d.name}</div>
                <div style="font-size:0.8rem;color:var(--muted)">Due day ${d.dueDay} · ${d.type.replace('_',' ')}</div>
              </div>
            </div>
            <div style="font-weight:700">${fmt(d.minPayment)}</div>
          </div>
        `).join('')}
        <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0">
          <strong>Total due this month</strong>
          <strong style="font-size:1.1rem">${fmt(state.debts.filter(d=>d.dueDay).reduce((s,d)=>s+d.minPayment,0))}</strong>
        </div>
      </div>
    `}
  `;
}

function calNav(dir) {
  state.calMonth += dir;
  if (state.calMonth < 0) { state.calMonth = 11; state.calYear--; }
  if (state.calMonth > 11) { state.calMonth = 0; state.calYear++; }
  renderCalendar();
}

/* ── Credit Health tab ───────────────────────────────────── */
function renderCredit() {
  const pane = document.getElementById('pane-credit');
  const score = state.creditScore;
  const util = totalUtilization();

  const scoreInfo = score => {
    if (!score) return { label: '—', cls: '' };
    if (score < 580) return { label: 'Poor', cls: 'danger', color: '#f07070' };
    if (score < 670) return { label: 'Fair', cls: 'warn', color: '#f0a060' };
    if (score < 740) return { label: 'Good', cls: '', color: '#f0d060' };
    if (score < 800) return { label: 'Very Good', cls: 'good', color: '#a0d060' };
    return { label: 'Excellent', cls: 'good', color: '#4fd1a0' };
  };
  const si = scoreInfo(score);

  const tips = [
    { icon: '📅', title: 'Pay on time, every time', desc: 'Payment history is 35% of your score. Even one missed payment can drop your score 50–100 points. Set up autopay for at least the minimum.' },
    { icon: '📉', title: 'Lower your utilization below 30%', desc: util !== null ? `Your current utilization is ${util.toFixed(1)}%. ${util > 30 ? 'This is hurting your score. Pay down balances to get below 30%, ideally below 10%.' : 'Good job! Keep it under 30%.'}` : 'Credit utilization makes up 30% of your score. Keep balances below 30% of your limit — ideally below 10% for the best score.' },
    { icon: '🔒', title: 'Keep old accounts open', desc: 'Credit history length is 15% of your score. Don\'t close your oldest credit cards even if you don\'t use them — they\'re boosting your average account age.' },
    { icon: '🎯', title: 'Don\'t open too many new accounts', desc: 'New credit is 10% of your score. Each hard inquiry can drop your score 5–10 points. Avoid applying for new credit while paying down debt.' },
    { icon: '🔄', title: 'Diversify your credit mix', desc: 'Credit mix is 10% of your score. Having a mix of revolving credit (cards) and installment loans (auto, mortgage) can help — but don\'t take on debt just for this.' },
    { icon: '💬', title: 'Dispute errors on your report', desc: 'Get a free report at annualcreditreport.com. Errors affect ~1 in 5 reports. Disputing and removing errors can quickly boost your score.' },
    { icon: '🤝', title: 'Become an authorized user', desc: 'Ask a family member with excellent credit to add you as an authorized user on their old card. Their history can appear on your report and boost your score.' },
    { icon: '⚡', title: 'Use Experian Boost or similar', desc: 'Services like Experian Boost let you add on-time utility, phone, and streaming payments to your credit file — free score bumps for bills you\'re already paying.' },
  ];

  pane.innerHTML = `
    <h2 class="section-title">Credit Health</h2>
    <p class="section-sub">Track your score and learn how to improve it.</p>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div class="card">
        <h2 style="margin-bottom:12px">My Credit Score</h2>
        <div style="display:flex;gap:12px;align-items:flex-end;margin-bottom:14px">
          <div class="form-group" style="flex:1">
            <label>Current score (300–850)</label>
            <input type="number" id="scoreInput" min="300" max="850" value="${score || ''}" placeholder="e.g. 680" />
          </div>
          <button class="btn btn-primary" onclick="saveScore()">Save</button>
        </div>
        ${score ? `
          <div class="score-gauge">
            <div class="score-number ${si.cls}" style="color:${si.color}">${score}</div>
            <div class="score-label" style="color:${si.color}">${si.label}</div>
          </div>
          <div class="score-range">
            <div class="score-range-seg poor"></div>
            <div class="score-range-seg fair"></div>
            <div class="score-range-seg good"></div>
            <div class="score-range-seg vgood"></div>
            <div class="score-range-seg excell"></div>
          </div>
          <div class="score-labels">
            <span>300</span><span>Poor</span><span>Fair</span><span>Good</span><span>V.Good</span><span>850</span>
          </div>
        ` : `<p style="font-size:0.85rem">Enter your score to see personalized guidance. Check Credit Karma, Mint, or your bank app.</p>`}
      </div>

      <div class="card">
        <h2 style="margin-bottom:12px">Score Factors</h2>
        <div class="factor-list">
          <div class="factor-item">
            <div><div class="factor-name">Payment History</div><div class="factor-desc">Pay every bill on time</div></div>
            <div class="factor-weight">35%</div>
          </div>
          <div class="factor-item">
            <div><div class="factor-name">Credit Utilization</div><div class="factor-desc">Keep balances low vs. limits</div></div>
            <div class="factor-weight">30%</div>
          </div>
          <div class="factor-item">
            <div><div class="factor-name">Credit History Length</div><div class="factor-desc">Older accounts = better</div></div>
            <div class="factor-weight">15%</div>
          </div>
          <div class="factor-item">
            <div><div class="factor-name">New Credit</div><div class="factor-desc">Limit hard inquiries</div></div>
            <div class="factor-weight">10%</div>
          </div>
          <div class="factor-item">
            <div><div class="factor-name">Credit Mix</div><div class="factor-desc">Cards + loans is ideal</div></div>
            <div class="factor-weight">10%</div>
          </div>
        </div>
      </div>
    </div>

    ${util !== null ? `
    <div class="card" style="margin-bottom:16px">
      <h2 style="margin-bottom:4px">Credit Utilization Breakdown</h2>
      <p style="font-size:0.83rem;color:var(--muted);margin-bottom:16px">
        Overall: <strong style="color:${util < 30 ? 'var(--accent)' : 'var(--red)'}">${util.toFixed(1)}%</strong>
        — aim for under 30%, ideally under 10% per card
      </p>
      <div class="util-summary">
        ${state.debts.filter(d => d.limit > 0).map(d => {
          const u = (d.balance / d.limit) * 100;
          const barColor = u < 10 ? 'var(--accent)' : u < 30 ? 'var(--yellow)' : 'var(--red)';
          return `
          <div class="util-card">
            <div class="util-card-name">${d.name}</div>
            <div class="util-bar-wrap">
              <div class="util-bar" style="width:${Math.min(100,u)}%;background:${barColor}"></div>
            </div>
            <div class="util-pct">${fmt(d.balance)} / ${fmt(d.limit)} · <strong style="color:${barColor}">${u.toFixed(1)}%</strong></div>
          </div>
          `;
        }).join('')}
      </div>
    </div>
    ` : ''}

    <div class="card">
      <h2 style="margin-bottom:16px">8 Ways to Improve Your Score</h2>
      <div class="tip-list">
        ${tips.map(t => `
          <div class="tip-item">
            <span class="tip-icon">${t.icon}</span>
            <div class="tip-text"><strong>${t.title}</strong>${t.desc}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

/* ── Debt modal ──────────────────────────────────────────── */
function openDebtModal(id) {
  const debt = id ? state.debts.find(d => d.id === id) : null;
  const modal = document.getElementById('debtModal');
  const form = document.getElementById('debtModalForm');

  document.getElementById('modalTitle').textContent = debt ? 'Edit Debt' : 'Add Debt';
  document.getElementById('debtId').value = debt ? debt.id : '';
  document.getElementById('debtName').value = debt ? debt.name : '';
  document.getElementById('debtType').value = debt ? debt.type : 'credit_card';
  document.getElementById('debtBalance').value = debt ? debt.balance : '';
  document.getElementById('debtLimit').value = debt ? (debt.limit || '') : '';
  document.getElementById('debtAPR').value = debt ? debt.apr : '';
  document.getElementById('debtMin').value = debt ? debt.minPayment : '';
  document.getElementById('debtDueDay').value = debt ? (debt.dueDay || '') : '';

  modal.style.display = 'flex';
  document.getElementById('debtName').focus();
}

function closeDebtModal() {
  document.getElementById('debtModal').style.display = 'none';
}

function saveDebt() {
  const id = document.getElementById('debtId').value;
  const name = document.getElementById('debtName').value.trim();
  const type = document.getElementById('debtType').value;
  const balance = parseFloat(document.getElementById('debtBalance').value) || 0;
  const limit = parseFloat(document.getElementById('debtLimit').value) || 0;
  const apr = parseFloat(document.getElementById('debtAPR').value) || 0;
  const minPayment = parseFloat(document.getElementById('debtMin').value) || 0;
  const dueDay = parseInt(document.getElementById('debtDueDay').value) || 0;

  if (!name || balance <= 0 || minPayment <= 0) {
    showToast('Please fill in name, balance, and minimum payment.');
    return;
  }

  if (id) {
    const idx = state.debts.findIndex(d => d.id === id);
    if (idx >= 0) {
      state.debts[idx] = { ...state.debts[idx], name, type, balance, limit, apr, minPayment, dueDay };
    }
  } else {
    state.debts.push({ id: uid(), name, type, balance, limit, apr, minPayment, dueDay, originalBalance: balance });
  }

  save();
  closeDebtModal();
  renderActiveTab();
  showToast(id ? 'Debt updated.' : 'Debt added.');
}

function deleteDebt(id) {
  if (!confirm('Delete this debt?')) return;
  state.debts = state.debts.filter(d => d.id !== id);
  save();
  renderActiveTab();
  showToast('Debt removed.');
}

function importExperianDebts() {
  const existingIds = new Set(state.debts.map(d => d.id));
  const toAdd = EXPERIAN_SEED_DEBTS.filter(s => !existingIds.has(s.id)).map(s => Object.assign({}, s));
  if (toAdd.length === 0) { showToast('All Experian debts already present.'); return; }
  state.debts = [...state.debts, ...toAdd];
  save();
  renderDebts();
  showToast(`Added ${toAdd.length} Experian debts.`);
}

/* ── Actions ─────────────────────────────────────────────── */
function setStrategy(s) {
  state.strategy = s;
  save();
  renderStrategy();
}

function applyExtra() {
  const val = parseFloat(document.getElementById('extraPayInput').value) || 0;
  state.extraPayment = val;
  save();
  renderStrategy();
}

function saveScore() {
  const val = parseInt(document.getElementById('scoreInput').value) || null;
  state.creditScore = val;
  save();
  renderCredit();
  showToast('Score saved.');
}

/* ── Toast ───────────────────────────────────────────────── */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ── Init ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  load();
  switchTab('overview');

  // Close modal on overlay click
  document.getElementById('debtModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('debtModal')) closeDebtModal();
  });
});
