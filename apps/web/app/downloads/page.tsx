'use client';

import Link from '../../components/nav-link';
import { useState } from 'react';
import { AppShell, panelClass, secondaryButtonClass } from '../../components/app-shell';
import { Badge, PageHeader } from '../../components/ui';

function Command({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  }
  return <div className="mt-3">
    <div className="mb-1 flex items-center justify-between gap-2"><span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      <button type="button" onClick={() => void copy()} className={`${secondaryButtonClass} !px-2 !py-1 text-xs`} aria-label={`Copiar comando: ${label}`}>{copied ? 'Copiado ✓' : 'Copiar'}</button></div>
    <pre className="overflow-x-auto rounded-xl bg-neutral-950 p-3 text-xs leading-relaxed text-emerald-200"><code>{text}</code></pre>
  </div>;
}

const windowsCommand = '.\\install-windows.ps1 -ApiUrl "https://SEU-DOMINIO-DA-API/api/v1" -Token "rmagt_COLE_O_TOKEN_AQUI"';
const manualCommand = 'cd apps/print-agent\nRM_API_URL=https://SEU-DOMINIO-DA-API/api/v1 RM_AGENT_TOKEN=rmagt_COLE_O_TOKEN_AQUI node src/agent.js';
const monorepoCommand = 'RM_API_URL=https://SEU-DOMINIO-DA-API/api/v1 RM_AGENT_TOKEN=rmagt_COLE_O_TOKEN_AQUI npm start --workspace apps/print-agent';
const removeCommand = 'Unregister-ScheduledTask -TaskName "RM Print Agent" -Confirm:$false';

export default function DownloadsPage() {
  return <AppShell title="Downloads e ajuda">
    <PageHeader title="Downloads e ajuda" subtitle="Agente de impressão: programa leve que roda no computador do restaurante e imprime os pedidos da cozinha nas impressoras locais." />
    <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
      <div className="space-y-4">
        <section className={panelClass} aria-labelledby="agent-title">
          <div className="flex flex-wrap items-center gap-2"><h3 id="agent-title" className="text-base font-bold text-slate-900">Agente de impressão</h3><Badge tone="gold">apps/print-agent</Badge></div>
          <p className="mt-2 text-sm text-slate-600">O agente consulta a API, imprime em ESC/POS e confirma o resultado. Ele não tem instalador baixável nesta tela: a pasta <code className="rounded bg-slate-100 px-1">apps/print-agent</code> faz parte do código do sistema e deve ser copiada para o computador onde as impressoras estão ligadas.</p>
          <ol className="mt-4 space-y-4 text-sm text-slate-700">
            <li><strong>1. Requisitos.</strong> Computador do restaurante ligado à internet e às impressoras, com <strong>Node.js 20 ou superior</strong> instalado. Copie a pasta <code className="rounded bg-slate-100 px-1">apps/print-agent</code> (peça ao responsável técnico pela instalação do sistema).</li>
            <li><strong>2. Crie o agente e copie o token.</strong> Em <Link href="/production" className="font-semibold text-brand-700 hover:underline">Setores e impressão</Link>, abra a seção de agentes e crie um agente. O token (<code className="rounded bg-slate-100 px-1">rmagt_…</code>) aparece <strong>uma única vez</strong>; guarde-o em local seguro.</li>
            <li><strong>3. Descubra o endereço da API.</strong> É o endereço do servidor da API terminado em <code className="rounded bg-slate-100 px-1">/api/v1</code>; use o valor fornecido por quem hospeda o sistema no lugar de <code className="rounded bg-slate-100 px-1">SEU-DOMINIO-DA-API</code>.</li>
            <li><strong>4a. Windows (recomendado).</strong> Abra o PowerShell <strong>como Administrador</strong> dentro da pasta do agente e execute o instalador, que cria uma tarefa agendada iniciada com o computador e reiniciada em caso de falha.
              <Command label="Instalar no Windows" text={windowsCommand} />
              <p className="mt-2 text-xs text-slate-500">Para remover: </p><Command label="Remover a tarefa" text={removeCommand} />
              <p className="mt-2 text-xs text-slate-500">O instalador ainda não foi validado em Windows neste ambiente de desenvolvimento; teste em uma máquina de homologação antes de usar em produção.</p></li>
            <li><strong>4b. Linux, macOS ou teste manual.</strong> Dentro da pasta do agente:
              <Command label="Executar manualmente" text={manualCommand} />
              <p className="mt-2 text-xs text-slate-500">A partir da raiz do projeto, o mesmo pode ser feito com:</p><Command label="Executar pela raiz do projeto" text={monorepoCommand} />
              <p className="mt-2 text-xs text-slate-500">Opcional: <code className="rounded bg-slate-100 px-1">RM_POLL_INTERVAL_MS</code> define o intervalo de consulta (padrão 3000 ms).</p></li>
            <li><strong>5. Confira.</strong> O terminal deve mostrar “RM print agent started”. Na tela de agentes o último contato é atualizado e os trabalhos da fila passam a ser impressos.</li>
          </ol>
        </section>
        <section className={panelClass} aria-labelledby="printer-title">
          <h3 id="printer-title" className="text-base font-bold text-slate-900">Como informar o endereço da impressora</h3>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li><strong>Rede:</strong> IP da impressora (ex.: 192.168.0.50), porta TCP 9100.</li>
            <li><strong>USB, compartilhada ou serial:</strong> caminho do dispositivo no computador do agente — Windows: <code className="rounded bg-slate-100 px-1">\\COMPUTADOR\IMPRESSORA</code> ou <code className="rounded bg-slate-100 px-1">COM3</code>; Linux: <code className="rounded bg-slate-100 px-1">/dev/usb/lp0</code>.</li>
          </ul>
        </section>
      </div>
      <aside className="space-y-4">
        <section className={panelClass}>
          <h3 className="text-base font-bold text-slate-900">Problemas comuns</h3>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-slate-700">
            <li>Agente sem contato: confira o endereço da API, o token e a conexão do computador.</li>
            <li>Nada imprime: verifique se a impressora do setor está ativa e com o endereço correto.</li>
            <li>Trabalhos em falha: após 3 tentativas ficam como falhos para reenvio manual. Se a impressora imprimiu mas a confirmação se perdeu, o ticket pode sair duplicado — confira o papel antes de reenviar.</li>
          </ul>
        </section>
        <section className={panelClass}>
          <h3 className="text-base font-bold text-slate-900">Outros arquivos</h3>
          <p className="mt-2 text-sm text-slate-600">O arquivo de produtos para balança é gerado em <Link href="/scale-file" className="font-semibold text-brand-700 hover:underline">Arquivo para balança</Link>.</p>
        </section>
      </aside>
    </div>
  </AppShell>;
}
