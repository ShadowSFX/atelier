/**
 * Every user-visible string, Spanish and English side by side (add both in one entry).
 * Placeholders: {0}, {1}… — a test checks both languages use the same ones.
 */
export type Lang = 'es' | 'en';

export const STRINGS = {
  // App shell
  'app.name': ['Atelier', 'Atelier'],
  'titlebar.search': ['Buscar proyectos, terminales y acciones', 'Search projects, terminals and actions'],
  'projects.add': ['Agregar proyecto', 'Add project'],
  'projects.addTitle': ['Elige la carpeta del proyecto', 'Choose the project folder'],
  'projects.rename': ['Cambiar nombre', 'Rename'],
  'projects.color': ['Color', 'Color'],
  'projects.reveal': ['Abrir carpeta', 'Open folder'],
  'projects.close': ['Cerrar proyecto', 'Close project'],
  'projects.closeConfirm': ['¿Cerrar «{0}» y sus {1} terminales?', 'Close "{0}" and its {1} terminals?'],
  'projects.missing': ['La carpeta del proyecto no existe: {0}', "The project folder doesn't exist: {0}"],
  'projects.exists': ['Ese proyecto ya está abierto', 'That project is already open'],
  'projects.notFolder': ['Solo se pueden agregar carpetas', 'Only folders can be added'],
  'projects.empty.title': ['Agrega tu primer proyecto', 'Add your first project'],
  'projects.empty.body': [
    'Un proyecto es una carpeta en la que trabajas. Sus terminales arrancan ahí y las sesiones de Claude solo se comunican dentro del mismo proyecto.',
    'A project is a folder you work in. Its terminals start there, and Claude sessions only talk to each other within the same project.',
  ],
  'projects.empty.drop': ['También puedes arrastrar una carpeta aquí', 'You can also drop a folder here'],

  // Sidebar / terminals
  'terminals.title': ['Terminales', 'Terminals'],
  'terminals.new': ['Nueva terminal', 'New terminal'],
  'terminals.newWith': ['Nueva terminal con…', 'New terminal with…'],
  'terminals.rename': ['Cambiar nombre', 'Rename'],
  'terminals.color': ['Color', 'Color'],
  'terminals.noColor': ['Sin color', 'No color'],
  'terminals.customColor': ['Otro color…', 'Custom color…'],
  'terminals.duplicate': ['Duplicar', 'Duplicate'],
  'terminals.restart': ['Reiniciar', 'Restart'],
  'terminals.close': ['Cerrar terminal', 'Close terminal'],
  'terminals.splitRight': ['Abrir a la derecha', 'Open to the right'],
  'terminals.empty': ['Este proyecto no tiene terminales.', 'This project has no terminals.'],
  'terminals.running': ['Ejecutando {0}', 'Running {0}'],
  'terminals.closeRunning': [
    '«{0}» está ejecutando un programa. ¿Cerrarla de todos modos?',
    '"{0}" is running a program. Close it anyway?',
  ],
  'terminals.defaultName': ['Terminal {0}', 'Terminal {0}'],

  // Panes
  'pane.close': ['Cerrar panel', 'Close pane'],
  'pane.split': ['Dividir a la derecha', 'Split right'],
  'pane.full': ['Ya hay 3 paneles', 'There are already 3 panes'],
  'pane.dropLeft': ['Abrir a la izquierda', 'Open on the left'],
  'pane.dropRight': ['Abrir a la derecha', 'Open on the right'],
  'pane.dropCenter': ['Mostrar aquí', 'Show here'],
  'pane.empty': ['Elige una terminal de la izquierda o crea una nueva.', 'Pick a terminal on the left or create a new one.'],

  // Terminal
  'term.starting': ['Iniciando {0}…', 'Starting {0}…'],
  'term.exited': ['El proceso terminó con código {0}.', 'The process exited with code {0}.'],
  'term.restartHint': ['Enter para reiniciar', 'Enter to restart'],
  'term.spawnFailed': ['No se pudo iniciar {0}: {1}', "Couldn't start {0}: {1}"],
  'term.cwdFallback': ['La carpeta {0} no existe; la terminal se abrió en tu carpeta personal.', "Folder {0} doesn't exist; the terminal opened in your home folder."],
  'term.restored': ['sesión restaurada', 'session restored'],
  'term.webglLost': ['La GPU se reinició; la terminal usa el renderizado de respaldo.', 'The GPU was reset; the terminal uses the fallback renderer.'],
  'term.copy': ['Copiar', 'Copy'],
  'term.paste': ['Pegar', 'Paste'],
  'term.pastePath': ['Pegar como ruta', 'Paste as path'],
  'term.selectAll': ['Seleccionar todo', 'Select all'],
  'term.find': ['Buscar', 'Find'],
  'term.copyLastOutput': ['Copiar salida del último comando', 'Copy last command output'],
  'term.saveOutput': ['Guardar salida…', 'Save output…'],
  'term.clear': ['Borrar historial', 'Clear history'],
  'term.saved': ['Salida guardada', 'Output saved'],
  'term.copied': ['Copiado', 'Copied'],
  'term.nothingToPaste': ['El portapapeles no tiene archivos ni texto', 'The clipboard has no files or text'],
  'term.noLastOutput': ['No hay salida de un comando anterior', 'There is no previous command output'],
  'term.pasteWarn.title': ['¿Pegar {0} líneas?', 'Paste {0} lines?'],
  'term.pasteWarn.body': [
    'Cada línea puede ejecutarse como un comando en cuanto llegue a la terminal.',
    'Each line may run as a command as soon as it reaches the terminal.',
  ],
  'term.pasteWarn.ok': ['Pegar', 'Paste'],
  'search.placeholder': ['Buscar', 'Find'],
  'search.none': ['Sin resultados', 'No results'],
  'search.case': ['Coincidir mayúsculas', 'Match case'],
  'search.word': ['Palabra completa', 'Whole word'],
  'search.regex': ['Expresión regular', 'Regular expression'],
  'search.prev': ['Anterior (Shift+Enter)', 'Previous (Shift+Enter)'],
  'search.next': ['Siguiente (Enter)', 'Next (Enter)'],
  'search.close': ['Cerrar (Esc)', 'Close (Esc)'],

  // Claude
  'claude.idle': ['Claude: libre', 'Claude: idle'],
  'claude.busy': ['Claude: trabajando', 'Claude: working'],
  'claude.permission': ['Claude: espera tu permiso', 'Claude: waiting for permission'],
  'claude.queued': ['{0} mensajes en cola — clic para entregar ahora', '{0} queued messages — click to deliver now'],
  'claude.sessions': ['{0} sesiones de Claude en el proyecto', '{0} Claude sessions in this project'],

  // Status bar
  'status.cpu': ['CPU', 'CPU'],
  'status.ram': ['RAM', 'RAM'],
  'status.disk': ['Disco', 'Disk'],
  'status.app': ['Atelier', 'Atelier'],
  'status.cpuTip': ['Uso de CPU del sistema', 'System CPU usage'],
  'status.ramTip': ['Memoria en uso: {0} de {1}', 'Memory in use: {0} of {1}'],
  'status.diskTip': ['Espacio usado en la unidad del proyecto: {0} de {1}', 'Space used on the project drive: {0} of {1}'],
  'status.appTip': ['Memoria que usa Atelier', 'Memory used by Atelier'],
  'status.termTip': ['CPU y memoria de la terminal activa y sus programas', 'CPU and memory of the active terminal and its programs'],
  'status.update': ['Versión {0} lista', 'Version {0} ready'],
  'status.restart': ['Reiniciar', 'Restart'],

  // Palette
  'palette.placeholder': ['Escribe para buscar un proyecto, una terminal o una acción', 'Type to find a project, terminal or action'],
  'palette.hint': ['Enter para abrir · Esc para cerrar', 'Enter to open · Esc to close'],
  'palette.project': ['Proyecto', 'Project'],
  'palette.terminal': ['Terminal', 'Terminal'],
  'palette.action': ['Acción', 'Action'],
  'palette.none': ['Nada coincide', 'Nothing matches'],

  // Settings
  'settings.title': ['Configuración', 'Settings'],
  'settings.appearance': ['Apariencia', 'Appearance'],
  'settings.terminal': ['Terminal', 'Terminal'],
  'settings.behavior': ['Comportamiento', 'Behavior'],
  'settings.claude': ['Claude Code', 'Claude Code'],
  'settings.language': ['Idioma', 'Language'],
  'settings.theme': ['Tema', 'Theme'],
  'settings.system': ['Sistema', 'System'],
  'settings.dark': ['Oscuro', 'Dark'],
  'settings.light': ['Claro', 'Light'],
  'settings.font': ['Fuente', 'Font'],
  'settings.fontSize': ['Tamaño de fuente', 'Font size'],
  'settings.lineHeight': ['Alto de línea', 'Line height'],
  'settings.scheme': ['Colores', 'Colors'],
  'settings.schemeAuto': ['Según el tema', 'Follow the theme'],
  'settings.renderer': ['Suavizado del texto', 'Text smoothing'],
  'settings.rendererGpu': ['GPU (escala de grises)', 'GPU (grayscale)'],
  'settings.rendererSubpixel': ['ClearType (subpíxel)', 'ClearType (subpixel)'],
  'settings.cursor': ['Cursor', 'Cursor'],
  'settings.cursorBar': ['Barra', 'Bar'],
  'settings.cursorBlock': ['Bloque', 'Block'],
  'settings.cursorUnderline': ['Subrayado', 'Underline'],
  'settings.cursorBlink': ['Cursor parpadeante', 'Blinking cursor'],
  'settings.scrollback': ['Líneas de historial', 'Scrollback lines'],
  'settings.tint': ['Teñir el fondo con el color de la terminal', "Tint the background with the terminal's color"],
  'settings.powerline': ['Prompt powerline de Atelier', "Atelier's powerline prompt"],
  'settings.powerlineHint': [
    'Se aplica a las terminales nuevas. Apágalo si usas tu propio prompt (oh-my-posh, starship).',
    'Applies to new terminals. Turn it off if you use your own prompt (oh-my-posh, starship).',
  ],
  'settings.defaultProfile': ['Shell por defecto', 'Default shell'],
  'settings.copyOnSelect': ['Copiar al seleccionar', 'Copy on select'],
  'settings.smartCtrlC': ['Ctrl+C copia si hay selección', 'Ctrl+C copies when there is a selection'],
  'settings.rightClick': ['Clic derecho', 'Right click'],
  'settings.rightClickMenu': ['Menú', 'Menu'],
  'settings.rightClickCopyPaste': ['Copiar / pegar', 'Copy / paste'],
  'settings.warnPaste': ['Avisar antes de pegar varias líneas', 'Warn before pasting several lines'],
  'settings.bell': ['Campana', 'Bell'],
  'settings.bellVisual': ['Visual', 'Visual'],
  'settings.bellSound': ['Sonido', 'Sound'],
  'settings.bellOff': ['Apagada', 'Off'],
  'settings.confirmClose': ['Confirmar al cerrar terminales con programas en ejecución', 'Confirm closing terminals that run programs'],
  'settings.claudeHub': ['Comunicación entre sesiones del mismo proyecto', 'Messaging between sessions of the same project'],
  'settings.claudeHubHint': [
    'Al ejecutar claude en una terminal de Atelier, la sesión puede ver y escribir solo a las demás sesiones de su proyecto (herramientas atelier_*). Las herramientas globales de Claude Code se desactivan dentro de Atelier. Se aplica a las terminales nuevas.',
    "When you run claude in an Atelier terminal, the session can see and message only the other sessions of its project (atelier_* tools). Claude Code's machine-wide messaging tools are turned off inside Atelier. Applies to new terminals.",
  ],
  'settings.done': ['Listo', 'Done'],

  // Generic
  'common.cancel': ['Cancelar', 'Cancel'],
  'common.ok': ['Aceptar', 'OK'],
  'common.close': ['Cerrar', 'Close'],
  'common.save': ['Guardar', 'Save'],
  'common.rename': ['Cambiar nombre', 'Rename'],
} as const satisfies Record<string, readonly [string, string]>;

export type StringKey = keyof typeof STRINGS;

export function translate(lang: Lang, key: StringKey, ...args: (string | number)[]): string {
  const pair = STRINGS[key] as readonly [string, string];
  const text = pair[lang === 'es' ? 0 : 1];
  return args.length === 0 ? text : text.replace(/\{(\d+)\}/g, (m, i: string) => (args[Number(i)] ?? m).toString());
}

export function resolveLang(setting: 'system' | Lang, locale: string): Lang {
  if (setting !== 'system') return setting;
  return locale.toLowerCase().startsWith('es') ? 'es' : 'en';
}
