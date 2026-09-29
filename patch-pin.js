const fs = require('fs');

// 1. Sidebar.jsx
let sidebar = fs.readFileSync('src/components/Sidebar.jsx', 'utf8');

if (!sidebar.includes('pin: [')) {
  sidebar = sidebar.replace("const ICONS = {", `const ICONS = {
  pin: ['M12 17v5', 'M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z'],
  chevronsLeft: ['M11 17l-5-5 5-5', 'M18 17l-5-5 5-5'],`);
}

if (!sidebar.includes('pinned = false')) {
  sidebar = sidebar.replace('export default function Sidebar({', 'export default function Sidebar({\n  pinned = false,\n  onTogglePin,');
}

const targetAside = 'mobile\n          ? // cajón superpuesto';
if (sidebar.includes(targetAside)) {
  const asideRegex = /className=\{\s*mobile\s*\?[\s\S]*?`\s*:\s*`absolute inset-y-0 left-0 z-30 flex flex-col border-r border-gray-200 bg-gray-50 shadow-2xl transition-transform duration-200 ease-out dark:border-neutral-800 dark:bg-\[#202020\] \$\{\s*isOpenVisual \? 'translate-x-0' : '-translate-x-full'\s*\}`\s*\}/;
  sidebar = sidebar.replace(asideRegex, `className={
        mobile
          ? \`fixed inset-0 z-30 flex w-full flex-col border-r border-gray-200 bg-gray-50 shadow-2xl transition-transform duration-200 ease-out dark:border-neutral-800 dark:bg-[#202020] \${
              isOpenVisual ? 'translate-x-0' : '-translate-x-full'
            }\`
          : pinned
          ? \`relative z-20 flex shrink-0 flex-col border-r border-gray-200 bg-gray-50 transition-all duration-200 ease-out dark:border-neutral-800 dark:bg-[#202020]\`
          : \`absolute inset-y-0 left-0 z-30 flex flex-col border-r border-gray-200 bg-gray-50 shadow-2xl transition-transform duration-200 ease-out dark:border-neutral-800 dark:bg-[#202020] \${
              isOpenVisual ? 'translate-x-0' : '-translate-x-full'
            }\`
      }`);
}

const oldBtn = `<button
          type="button"
          aria-label="Ocultar sidebar"
          onClick={onCollapse}
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <Icon d={ICONS.x} className="h-4 w-4" />
        </button>`;

const newBtn = `<div className="flex items-center gap-1">
          {!mobile && (
            <button
              type="button"
              aria-label={pinned ? 'Desanclar sidebar' : 'Fijar sidebar'}
              title={pinned ? 'Desanclar sidebar (modo flotante)' : 'Fijar sidebar (quedar fija)'}
              onClick={onTogglePin}
              className={\`rounded-md p-1.5 transition-colors \${
                pinned
                  ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/60 dark:text-blue-400 font-semibold shadow-xs'
                  : 'text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
              }\`}
            >
              <Icon d={ICONS.pin} className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            aria-label="Ocultar sidebar"
            title="Ocultar sidebar"
            onClick={onCollapse}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 transition-colors"
          >
            <Icon d={mobile ? ICONS.x : ICONS.chevronsLeft} className="h-4 w-4" />
          </button>
        </div>`;

sidebar = sidebar.replace(oldBtn, newBtn);
fs.writeFileSync('src/components/Sidebar.jsx', sidebar);
console.log('✓ Sidebar.jsx listo');

// 2. App.jsx
let app = fs.readFileSync('src/App.jsx', 'utf8');

if (!app.includes('togglePin')) {
  app = app.replace(
    'const [sidebarMounted, setSidebarMounted] = useState(sidebarOpen)',
    `const [sidebarMounted, setSidebarMounted] = useState(sidebarOpen)
  const [pinned, setPinned] = useState(() => {
    try {
      const saved = localStorage.getItem('flashlab-sidebar-pinned')
      return saved !== null ? saved === 'true' : !isMobileNow()
    } catch {
      return !isMobileNow()
    }
  })

  const togglePin = () => {
    setPinned((prev) => {
      const next = !prev
      try {
        localStorage.setItem('flashlab-sidebar-pinned', String(next))
      } catch {}
      if (next && !sidebarOpen) {
        setSidebarOpen(true)
      }
      return next
    })
  }`
  );

  app = app.replace(
    'const withSidebarClose = (fn) => (...args) => {\n    fn(...args)\n    setSidebarOpen(false)\n  }',
    `const withSidebarClose = (fn) => (...args) => {
    fn(...args)
    if (isMobile || !pinned) {
      setSidebarOpen(false)
    }
  }`
  );

  app = app.replace(
    '{sidebarMounted && <SidebarBackdrop onClick={() => setSidebarOpen(false)} confined={!isMobile} open={sidebarOpen} />}',
    '{sidebarMounted && (isMobile || !pinned) && <SidebarBackdrop onClick={() => setSidebarOpen(false)} confined={!isMobile} open={sidebarOpen} />}'
  );

  app = app.replace(
    '<Sidebar\n            mobile={isMobile}',
    '<Sidebar\n            pinned={!isMobile && pinned}\n            onTogglePin={togglePin}\n            mobile={isMobile}'
  );

  fs.writeFileSync('src/App.jsx', app);
  console.log('✓ App.jsx listo');
}

// 3. package.json
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '0.1.71';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
console.log('✓ package.json en v0.1.71');
