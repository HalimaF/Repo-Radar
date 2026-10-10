// Read-only client for a running Repo Pilot backend. Repo Radar never changes Repo Pilot;
// it only calls its HTTP API. Paths below are defaults and can be overridden in Settings,
// because only /api/ask and /api/code-health/report are documented in Repo Pilot's README.
export const DEFAULT_ENDPOINTS = {
  ingest: '/api/ingest',
  diagram: '/api/diagram',
  codeHealth: '/api/code-health',
  onboarding: '/api/onboarding',
  ask: '/api/ask',
};

export function makeRepoPilot(baseUrl, endpoints = {}, fetchImpl = fetch) {
  const ep = { ...DEFAULT_ENDPOINTS, ...endpoints };
  const root = baseUrl.replace(/\/+$/, '');

  async function post(name, body) {
    const res = await fetchImpl(root + ep[name], {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).detail ?? ''; } catch {}
      throw new Error(`Repo Pilot ${ep[name]} → ${res.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    }
    return res.json();
  }

  return {
    ingest: repoUrl => post('ingest', { repo_url: repoUrl }),
    diagram: async repoUrl => normalizeDiagram(await post('diagram', { repo_url: repoUrl })),
    codeHealth: async repoUrl => normalizeHealth(await post('codeHealth', { repo_url: repoUrl })),
    onboarding: repoUrl => post('onboarding', { repo_url: repoUrl }),
    ask: (repoUrl, question) => post('ask', { repo_url: repoUrl, question }),
  };
}

// Response shapes are not documented, so accept the obvious key names.
export function normalizeDiagram(r) {
  const mermaid = r?.mermaid ?? r?.diagram ?? r?.mermaid_code ?? r?.code ?? (typeof r === 'string' ? r : null);
  return { mermaid, aggregated: !!(r?.aggregated ?? r?.folder_level) };
}

export function normalizeHealth(r) {
  const findings = (r?.findings ?? r?.issues ?? []).map(f => ({
    title: f.title ?? f.message ?? f.check ?? 'Finding',
    severity: String(f.severity ?? f.level ?? 'info').toLowerCase(),
    file: f.file ?? f.path ?? f.files?.[0] ?? null,
  }));
  return {
    score: typeof r?.score === 'number' ? Math.round(r.score) : null,
    grade: r?.grade ?? null,
    summary: r?.summary ?? r?.meaning ?? r?.headline ?? '',
    nextStep: r?.next_step ?? r?.nextStep ?? '',
    findings,
  };
}
