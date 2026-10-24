#!/usr/bin/env node
/**
 * gods — sobe o projeto God's Eye inteiro (app + video + voz).
 *
 *   gods            sobe tudo
 *   gods stop       derruba tudo
 *   gods status     o que esta rodando
 *
 * Expoe o Vite na rede local (--host) pra abrir do celular.
 */
const { spawn, execSync } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

const ROOT = process.env.GODS_ROOT || "C:/Users/user/Documents/projetos/gods-eye-view";
const PIDFILE = path.join(ROOT, ".gods.pids");
const PORT = 4173, CAPTURE = 8082, VOICE = 8083;

function lanIP() {
  for (const n of Object.keys(os.networkInterfaces()))
    for (const net of os.networkInterfaces()[n])
      if (net.family === "IPv4" && !net.internal && net.address.startsWith("192."))
        return net.address;
  for (const n of Object.keys(os.networkInterfaces()))
    for (const net of os.networkInterfaces()[n])
      if (net.family === "IPv4" && !net.internal) return net.address;
  return "127.0.0.1";
}

function up(url) {
  try {
    return execSync(`curl -s -o NUL -w "%{http_code}" --max-time 2 ${url}`,
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch { return "000"; }
}

/** PIDs escutando numa porta TCP (Windows netstat). */
function pidsNaPorta(porta) {
  const out = [];
  try {
    const txt = execSync("netstat -ano -p TCP", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    for (const line of txt.split(/\r?\n/)) {
      if (!line.includes(`:${porta} `) || !/LISTENING/i.test(line)) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid) && !out.includes(pid)) out.push(pid);
    }
  } catch {}
  return out;
}

/**
 * Mata SO o Chrome do capture (Puppeteer).
 *
 * Identifica pelos processos cujo command line carrega o marker
 * --gev-capture ou o userDataDir dedicado. NUNCA `taskkill /IM chrome.exe`:
 * isso derrubaria tambem o Chrome normal do usuario.
 */
function killCaptureChrome() {
  // wmic foi removido em versoes novas do Windows; PowerShell com -EncodedCommand
  // evita TODO o inferno de escape de aspas.
  const script = [
    "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\"",
    "| Where-Object { $_.CommandLine -like '*gev-capture-chrome*' }",
    "| ForEach-Object { $_.ProcessId }",
  ].join(" ");
  let alvos = [];
  try {
    const b64 = Buffer.from(script, "utf16le").toString("base64");
    const saida = execSync(`powershell -NoProfile -EncodedCommand ${b64}`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    alvos = saida.split(/\s+/).map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
  } catch {
    /* powershell indisponivel */
  }
  if (!alvos.length) {
    console.log("  (nenhum Chrome de capture rodando)");
    return;
  }
  matar(alvos, "chrome do capture");
}

function matar(pids, rotulo) {
  for (const p of pids) {
    try {
      execSync(`taskkill /PID ${p} /F /T`, { stdio: "ignore" });
      console.log(`  matei ${rotulo} (pid ${p})`);
    } catch {}
  }
}

/**
 * Derruba tudo de verdade: o PID file pode faltar (processo subiu por fora,
 * ou o arquivo foi apagado) e ai o `gods` acha que ainda esta no ar porque
 * a porta responde. Aqui matamos o que estiver escutando nas nossas portas.
 */
function killPids() {
  // 1) o que o proprio gods registrou
  if (fs.existsSync(PIDFILE)) {
    const pids = fs.readFileSync(PIDFILE, "utf-8").split(/\s+/).filter(Boolean);
    matar(pids, "registrado");
    try { fs.unlinkSync(PIDFILE); } catch {}
  }
  // 2) o que estiver segurando as portas (vite/capture/voice)
  for (const [rotulo, porta] of [["vite", PORT], ["capture", CAPTURE], ["voice", VOICE]]) {
    const pids = pidsNaPorta(porta);
    if (pids.length) matar(pids, `${rotulo} :${porta}`);
  }
}

function start(name, cmd, args, cwd) {
  const child = spawn(cmd, args, {
    cwd, detached: true, stdio: "ignore",
    windowsHide: true,   // sem janela de console por filho
  });
  child.unref();
  return child.pid;
}

function main() {
  const action = (process.argv[2] || "up").toLowerCase();

  if (action === "stop") {
    killPids();
    killCaptureChrome();
    console.log("gods: parado.");
    return;
  }

  if (action === "status") {
    const ip = lanIP();
    console.log(`vite     :4173  ${up("http://127.0.0.1:4173/")}`);
    console.log(`capture  :${CAPTURE}  ${up(`http://127.0.0.1:${CAPTURE}/`)}`);
    console.log(`voice    :${VOICE}  ${up(`http://127.0.0.1:${VOICE}/mic.json`)}`);
    console.log(`\ncelular: http://${ip}:${PORT}`);
    return;
  }

  if (!fs.existsSync(ROOT)) {
    console.error("gods: projeto nao encontrado em", ROOT);
    process.exit(1);
  }

  // ja rodando? evita duplicar
  if (up("http://127.0.0.1:4173/") === "200") {
    const registrado = fs.existsSync(PIDFILE);
    console.log("gods: ja esta rodando (use `gods stop` pra derrubar).");
    if (!registrado) {
      const pids = pidsNaPorta(PORT);
      console.log(
        `  AVISO: o vite esta no ar (pid ${pids.join(", ") || "?"}) mas nao foi` +
        " iniciado por este comando. `gods stop` tambem derruba ele.",
      );
    }
    console.log(`  celular: http://${lanIP()}:${PORT}`);
    return;
  }

  console.log("gods: subindo...");
  const pids = [];
  const node = process.execPath;

  // 1) Vite, exposto na rede (--host)
  pids.push(start("vite", node, ["node_modules/vite/bin/vite.js", "--host", "0.0.0.0"], ROOT));
  console.log("  [1/3] vite (rede)...");

  // espera o vite responder
  let ok = false;
  for (let i = 0; i < 40; i++) {
    execSync("ping -n 1 127.0.0.1 > NUL", { stdio: "ignore", timeout: 3000 });
    if (up("http://127.0.0.1:4173/") === "200") { ok = true; break; }
  }
  if (!ok) console.log("  [aviso] vite demorou; seguindo mesmo assim");

  // 2) capture-server (abre o Chrome no PC com o globo)
  pids.push(start("capture", node, ["tools/esp-capture-server.cjs", "--port", String(CAPTURE), "--size", "240"], ROOT));
  console.log("  [2/3] capture (video, Chrome no PC)...");

  // 3) voice-server
  pids.push(start("voice", node, ["tools/voice-server.cjs", "--port", String(VOICE)], ROOT));
  console.log("  [3/3] voice (STT + IA)...");

  fs.writeFileSync(PIDFILE, pids.join(" "));

  console.log("\n  aguardando estabilizar (~50s pro globo carregar)...");
  for (let i = 0; i < 50; i++) execSync("ping -n 1 127.0.0.1 > NUL", { stdio: "ignore", timeout: 3000 });

  const ip = lanIP();
  console.log("\n  ------------------------------------------------");
  console.log("  GOD'S EYE no ar");
  console.log("  ------------------------------------------------");
  console.log(`  PC       : http://localhost:${PORT}`);
  console.log(`  CELULAR  : http://${ip}:${PORT}          (app completo)`);
  console.log(`  CELULAR  : http://${ip}:${PORT}/?embed=1  (so o globo)`);
  console.log(`  VOZ/mic  : http://localhost:${VOICE}/mic`);
  console.log("  ------------------------------------------------");
  console.log("  parar    : gods stop");

  // aviso de firewall: o celular pede uma regra de entrada nas portas
  if (!hasFirewallRule()) {
    console.log("\n  [ATENCAO] Firewall sem regra para as portas " + PORT + "," + CAPTURE + "," + VOICE + ".");
    console.log("  Se o celular der 'connection refused', rode UMA vez no");
    console.log("  PowerShell COMO ADMINISTRADOR:");
    console.log(`    New-NetFirewallRule -DisplayName "Gods Eye" -Direction Inbound \\`);
    console.log(`      -LocalPort ${PORT},${CAPTURE},${VOICE} -Protocol TCP -Action Allow -Profile Private`);
  }
  console.log("");
}

/** true se ja existe uma regra de entrada liberando a porta do Vite. */
function hasFirewallRule() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-NetFirewallRule -Direction Inbound -Enabled True | Where-Object { $_.DisplayName -match 'Gods Eye|node' } | Measure-Object).Count"`,
      { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).toString().trim();
    return parseInt(out, 10) > 0;
  } catch { return false; }
}

main();
