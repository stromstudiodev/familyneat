/* ============================================================
   FAMILY NEAT — script.js
   Navegación entre pantallas + integración real con Firebase
   (Firestore para datos, Authentication anónima para poder
   leer/escribir según las reglas de seguridad).
   ============================================================ */

(() => {
  'use strict';

  /* ================================================================
     0. FIREBASE — inicialización
     ================================================================ */
  let db = null;
  let firebaseListo = false;

  function inicializarFirebase() {
    try {
      if (!window.FIREBASE_CONFIG || window.FIREBASE_CONFIG.apiKey === 'PEGA_AQUI_TU_API_KEY') {
        throw new Error('Falta configurar firebase-config.js con las claves de tu proyecto.');
      }
      firebase.initializeApp(window.FIREBASE_CONFIG);
      db = firebase.firestore();
      return firebase.auth().signInAnonymously();
    } catch (error) {
      console.error('[Family Neat] Error al inicializar Firebase:', error.message);
      return Promise.reject(error);
    }
  }

  /* ================================================================
     1. UTILIDADES GENERALES
     ================================================================ */
  const PALETA_AVATARES = ['#FF6B5B', '#4FA8E0', '#00C9A7', '#9B79F0', '#FF9F43'];
  const colorAleatorio = () => PALETA_AVATARES[Math.floor(Math.random() * PALETA_AVATARES.length)];

  const ESTANCIA_LABEL = { salon: 'Salón', cocina: 'Cocina', bano: 'Baño', habitacion: 'Habitación' };
  const ESTADO_LABEL = {
    pendiente: { texto: '🕓 Pendiente', clase: 'estado-pendiente' },
    revision: { texto: '⏳ En revisión', clase: 'estado-revision' },
    aprobada: { texto: '✅ Aprobada', clase: 'estado-aprobada' },
    rechazada: { texto: '↩️ Rechazada', clase: 'estado-rechazada' },
  };

  function normalizarCodigo(valor) {
    return (valor || '').toUpperCase().replace('NEAT-', '').replace(/\s/g, '').trim();
  }

  // Hash simple con Web Crypto (SHA-256). No sustituye a un backend con
  // sal + pimienta, pero evita guardar PIN/contraseñas en texto plano.
  async function hashTexto(texto) {
    const datos = new TextEncoder().encode(texto);
    const hashBuffer = await crypto.subtle.digest('SHA-256', datos);
    return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function generarCodigoFamilia() {
    for (let intento = 0; intento < 6; intento++) {
      const codigo = String(Math.floor(100000 + Math.random() * 900000));
      const existe = await db.collection('familias').where('codigo', '==', codigo).limit(1).get();
      if (existe.empty) return codigo;
    }
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  function formatearDinero(valor) {
    return `${Number(valor || 0).toFixed(2).replace('.', ',')} €`;
  }

  // Convierte una fecha en formato ISO (yyyy-mm-dd) a algo legible en
  // español. Si no viene en ese formato (datos antiguos), la muestra tal cual.
  function formatearFecha(fechaISO) {
    if (!fechaISO) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaISO)) return fechaISO;

    const [anio, mes, dia] = fechaISO.split('-').map(Number);
    const fecha = new Date(anio, mes - 1, dia);
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    const manana = new Date(hoy); manana.setDate(hoy.getDate() + 1);

    if (fecha.getTime() === hoy.getTime()) return 'Hoy';
    if (fecha.getTime() === manana.getTime()) return 'Mañana';

    const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    return `${dia} ${MESES[mes - 1]}`;
  }

  // Renderiza la fecha y la hora de una tarea como dos partes separadas
  // dentro de un mismo bloque (ej. "Hoy · 20:00"). Soporta tareas antiguas
  // que solo tenían el campo "fecha" como texto libre, sin hora.
  function renderizarFechaHora(tarea) {
    const fechaTexto = formatearFecha(tarea.fecha);
    if (!fechaTexto) return '';
    const horaHtml = tarea.hora
      ? `<span class="separador-fh" aria-hidden="true"></span><span>${tarea.hora}</span>`
      : '';
    return `<span class="fecha-hora">${fechaTexto} ${horaHtml}</span>`;
  }

  /* ================================================================
     2. ESTADO EN MEMORIA
     ================================================================ */
  const ESTADO = {
    pantallaActual: null,
    historial: [],
    registroTemporalAdulto: null, // { nombre, email, password }
    familiaActual: null,          // { id, nombre, codigo }
    miembroActual: null,          // { id, nombre, rol, ... }
    perfilSeleccionado: null,     // miembro elegido en la pantalla de login por perfiles
    tareasFamiliaCache: [],       // última foto de tareas (vista del padre) para filtrar sin recargar
    filtroTareasPadre: 'todas',
    hijosFamiliaCache: [],        // última foto de miembros con rol hijo (vista del padre)
    listenersActivos: [],         // funciones "unsubscribe" de Firestore en curso
  };

  function limpiarListeners() {
    ESTADO.listenersActivos.forEach((cancelar) => cancelar());
    ESTADO.listenersActivos = [];
  }

  /* ================================================================
     3. NAVEGACIÓN ENTRE PANTALLAS
     ================================================================ */
  const PANTALLAS_DASHBOARD_HIJO = ['pantalla-tareas-hijo', 'pantalla-banco-hijo', 'pantalla-objetivos-hijo'];
  const PANTALLAS_DASHBOARD_PADRE = ['pantalla-padre-inicio', 'pantalla-padre-tareas', 'pantalla-padre-aprobaciones'];
  const PANTALLAS_SIN_ATRAS = ['pantalla-inicio', ...PANTALLAS_DASHBOARD_HIJO, ...PANTALLAS_DASHBOARD_PADRE];

  // Formularios que deben quedar completamente vacíos si el usuario sale de
  // esa pantalla (con el botón atrás o navegando a otro sitio) sin terminar.
  const FORMULARIOS_LIMPIAR_AL_SALIR = {
    'pantalla-registro-hijo': 'form-registro-hijo',
    'pantalla-registro-adulto': 'form-registro-adulto',
  };

  function limpiarFormularioDePantalla(idPantalla) {
    const idFormulario = FORMULARIOS_LIMPIAR_AL_SALIR[idPantalla];
    if (!idFormulario) return;
    const formulario = document.getElementById(idFormulario);
    if (!formulario) return;
    formulario.reset();
    formulario.querySelectorAll('.campo-form.con-error').forEach((c) => c.classList.remove('con-error'));
    formulario.querySelectorAll('.campo-error').forEach((c) => c.classList.remove('campo-error'));
  }

  function sonHermanas(a, b) {
    return (PANTALLAS_DASHBOARD_HIJO.includes(a) && PANTALLAS_DASHBOARD_HIJO.includes(b))
      || (PANTALLAS_DASHBOARD_PADRE.includes(a) && PANTALLAS_DASHBOARD_PADRE.includes(b));
  }

  function irAPantalla(idPantalla, opciones = {}) {
    const destino = document.getElementById(idPantalla);
    if (!destino || idPantalla === ESTADO.pantallaActual) return;

    const esVolver = !!opciones.esVolver;
    if (!esVolver && ESTADO.pantallaActual && !sonHermanas(idPantalla, ESTADO.pantallaActual)) {
      ESTADO.historial.push(ESTADO.pantallaActual);
    }

    // Si la pantalla que dejamos atrás tenía un formulario de registro,
    // se limpia para que no queden datos a medio rellenar la próxima vez.
    if (ESTADO.pantallaActual && ESTADO.pantallaActual !== idPantalla) {
      limpiarFormularioDePantalla(ESTADO.pantallaActual);
    }

    document.querySelectorAll('.pantalla.activa').forEach((el) => el.classList.remove('activa'));
    destino.classList.add('activa');
    ESTADO.pantallaActual = idPantalla;
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

    actualizarNavInferior(idPantalla);
    actualizarBotonesAtras(idPantalla);
    if (history.replaceState) history.replaceState(null, '', `#${idPantalla}`);
  }

  function volverAtras() {
    let anterior = ESTADO.historial.pop();
    while (anterior === ESTADO.pantallaActual && ESTADO.historial.length) {
      anterior = ESTADO.historial.pop();
    }
    irAPantalla(anterior || 'pantalla-inicio', { esVolver: true });
  }

  function actualizarNavInferior(idPantalla) {
    document.querySelectorAll('footer nav a').forEach((enlace) => {
      const objetivo = enlace.getAttribute('href')?.replace('#', '');
      enlace.classList.toggle('activo', objetivo === idPantalla);
    });
  }

  function actualizarBotonesAtras(idPantalla) {
    document.querySelectorAll('.btn-atras').forEach((boton) => {
      const pantallaPadre = boton.closest('.pantalla');
      if (pantallaPadre && pantallaPadre.id === idPantalla) {
        boton.style.visibility = PANTALLAS_SIN_ATRAS.includes(idPantalla) ? 'hidden' : 'visible';
      }
    });
  }

  function inicializarNavegacion() {
    document.body.addEventListener('click', (evento) => {
      const botonVolver = evento.target.closest('[data-accion="volver"]');
      if (botonVolver) {
        evento.preventDefault();
        volverAtras();
        return;
      }
      const disparador = evento.target.closest('[data-ir], a[href^="#pantalla-"]');
      if (!disparador) return;
      evento.preventDefault();
      const destino = disparador.dataset.ir || disparador.getAttribute('href').replace('#', '');
      irAPantalla(destino);
    });

    const inicial = window.location.hash.replace('#', '');
    irAPantalla(document.getElementById(inicial) ? inicial : 'pantalla-inicio');
  }

  /* ================================================================
     4. TOASTS
     ================================================================ */
  function mostrarToast(mensaje, tipo = 'info') {
    let region = document.getElementById('toast-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'toast-region';
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${tipo === 'exito' ? 'exito' : tipo === 'error' ? 'error' : ''}`.trim();
    toast.textContent = mensaje;
    region.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('saliendo');
      setTimeout(() => toast.remove(), 220);
    }, 2800);
  }

  /* ================================================================
     5. VALIDACIÓN GENÉRICA DE FORMULARIOS
     ================================================================ */
  function validarFormulario(formulario) {
    let esValido = true;
    formulario.querySelectorAll('[required]').forEach((campo) => {
      const contenedor = campo.closest('.campo-form') || campo.parentElement;
      const valorValido = campo.checkValidity();
      if (!valorValido) esValido = false;
      if (contenedor && contenedor.classList.contains('campo-form')) {
        contenedor.classList.toggle('con-error', !valorValido);
        campo.classList.toggle('campo-error', !valorValido);
      }
    });
    return esValido;
  }

  function marcarCampoError(campo, esError) {
    const contenedor = campo.closest('.campo-form');
    if (contenedor) contenedor.classList.toggle('con-error', esError);
    campo.classList.toggle('campo-error', esError);
  }

  /* ================================================================
     6. ACCESO A FIRESTORE — familias y miembros
     ================================================================ */
  async function buscarFamiliaPorCodigo(codigo) {
    const resultado = await db.collection('familias').where('codigo', '==', codigo).limit(1).get();
    if (resultado.empty) return null;
    const doc = resultado.docs[0];
    return { id: doc.id, ...doc.data() };
  }

  async function crearFamiliaConAdulto(nombreFamilia) {
    const datosAdulto = ESTADO.registroTemporalAdulto;
    if (!datosAdulto) throw new Error('Falta información del registro del adulto.');

    const codigo = await generarCodigoFamilia();
    const familiaRef = await db.collection('familias').add({
      nombre: nombreFamilia,
      codigo,
      creadaEn: firebase.firestore.FieldValue.serverTimestamp(),
    });

    const secretoHash = await hashTexto(datosAdulto.password);
    const miembroRef = await familiaRef.collection('miembros').add({
      nombre: datosAdulto.nombre,
      rol: 'padre',
      secretoHash,
      aprobado: true,
      avatarColor: colorAleatorio(),
      saldoDinero: 0,
      saldoPuntos: 0,
      creadoEn: firebase.firestore.FieldValue.serverTimestamp(),
    });

    ESTADO.familiaActual = { id: familiaRef.id, nombre: nombreFamilia, codigo };
    ESTADO.miembroActual = { id: miembroRef.id, nombre: datosAdulto.nombre, rol: 'padre' };
    return codigo;
  }

  async function unirsePadreAFamilia(codigo) {
    const familia = await buscarFamiliaPorCodigo(codigo);
    if (!familia) return null;

    const datosAdulto = ESTADO.registroTemporalAdulto;
    const secretoHash = await hashTexto(datosAdulto.password);

    // Un segundo padre que se une también pasa por aprobación del primero.
    const miembroRef = await db.collection('familias').doc(familia.id).collection('miembros').add({
      nombre: datosAdulto.nombre,
      rol: 'padre',
      secretoHash,
      aprobado: false,
      avatarColor: colorAleatorio(),
      saldoDinero: 0,
      saldoPuntos: 0,
      creadoEn: firebase.firestore.FieldValue.serverTimestamp(),
    });

    return { familiaId: familia.id, miembroId: miembroRef.id };
  }

  async function registrarHijo(nombre, pin, codigo) {
    const familia = await buscarFamiliaPorCodigo(codigo);
    if (!familia) return null;

    const secretoHash = await hashTexto(pin);
    const familiaRef = db.collection('familias').doc(familia.id);
    const miembroRef = await familiaRef.collection('miembros').add({
      nombre,
      rol: 'hijo',
      secretoHash,
      aprobado: false,
      avatarColor: colorAleatorio(),
      saldoDinero: 0,
      saldoPuntos: 0,
      creadoEn: firebase.firestore.FieldValue.serverTimestamp(),
    });

    await sembrarDatosDemo(familiaRef, miembroRef.id, nombre);
    return { familiaId: familia.id, miembroId: miembroRef.id };
  }

  // Añade un par de tareas/movimientos/objetivo de ejemplo al hijo recién
  // creado para que el padre tenga algo que revisar y aprobar de inmediato.
  async function sembrarDatosDemo(familiaRef, miembroId, nombreHijo) {
    const lote = db.batch();
    const ahora = firebase.firestore.FieldValue.serverTimestamp();
    const hoy = new Date();
    const ayer = new Date(hoy); ayer.setDate(hoy.getDate() - 1);
    const isoFecha = (d) => d.toISOString().slice(0, 10);

    const tarea1 = familiaRef.collection('tareas').doc();
    lote.set(tarea1, {
      titulo: 'Hacer la cama', estancia: 'habitacion', miembroId, miembroNombre: nombreHijo,
      dinero: 0.5, puntos: 10, estado: 'pendiente', fecha: isoFecha(hoy), hora: '09:00', creadoEn: ahora,
    });
    const tarea2 = familiaRef.collection('tareas').doc();
    lote.set(tarea2, {
      titulo: 'Ordenar el baño', estancia: 'bano', miembroId, miembroNombre: nombreHijo,
      dinero: 1, puntos: 15, estado: 'revision', fecha: isoFecha(ayer), hora: '20:00', creadoEn: ahora,
    });
    const objetivo1 = familiaRef.collection('objetivos').doc();
    lote.set(objetivo1, { miembroId, nombre: 'Mi primer objetivo', total: 20, actual: 0, creadoEn: ahora });

    await lote.commit();
  }

  async function cargarMiembros(familiaId) {
    const snapshot = await db.collection('familias').doc(familiaId).collection('miembros').get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  /* ================================================================
     7. ACCIONES SOBRE TAREAS / SALDO
     ================================================================ */
  function refFamilia() {
    return db.collection('familias').doc(ESTADO.familiaActual.id);
  }

  async function crearTareaNueva(datos) {
    await refFamilia().collection('tareas').add({
      ...datos,
      estado: 'pendiente',
      creadoEn: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async function marcarTareaComoHecha(tareaId) {
    await refFamilia().collection('tareas').doc(tareaId).update({ estado: 'revision' });
  }

  async function reintentarTarea(tareaId) {
    await refFamilia().collection('tareas').doc(tareaId).update({ estado: 'pendiente' });
  }

  async function resolverTarea(tareaId, aprobar) {
    const tarea = ESTADO.tareasFamiliaCache.find((t) => t.id === tareaId);
    if (!tarea) return;

    const tareaRef = refFamilia().collection('tareas').doc(tareaId);
    if (!aprobar) {
      await tareaRef.update({ estado: 'rechazada' });
      return;
    }

    const miembroRef = refFamilia().collection('miembros').doc(tarea.miembroId);
    const movRef = refFamilia().collection('movimientos').doc();
    const lote = db.batch();
    lote.update(tareaRef, { estado: 'aprobada' });
    lote.update(miembroRef, {
      saldoDinero: firebase.firestore.FieldValue.increment(tarea.dinero || 0),
      saldoPuntos: firebase.firestore.FieldValue.increment(tarea.puntos || 0),
    });
    lote.set(movRef, {
      miembroId: tarea.miembroId,
      texto: tarea.titulo,
      importe: tarea.dinero || 0,
      creadoEn: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await lote.commit();
  }

  async function aprobarHijo(miembroId) {
    await refFamilia().collection('miembros').doc(miembroId).update({ aprobado: true });
  }

  async function rechazarHijo(miembroId) {
    await refFamilia().collection('miembros').doc(miembroId).delete();
  }

  async function crearObjetivoNuevo(nombre, total) {
    await refFamilia().collection('objetivos').add({
      miembroId: ESTADO.miembroActual.id,
      nombre,
      total,
      actual: 0,
      creadoEn: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  /* ================================================================
     8. RENDERIZADO — VISTA HIJO
     ================================================================ */
  function ponerNombreEnCabeceras(selectorPantallas, nombre) {
    selectorPantallas.forEach((id) => {
      const p = document.querySelector(`#${id} .header-contenido p`);
      if (p) p.textContent = nombre;
    });
  }

  function renderizarTareasHijo(docs) {
    const contenedor = document.querySelector('#pantalla-tareas-hijo .tareas');
    const contador = document.querySelector('#pantalla-tareas-hijo .contador-tareas');
    if (!contenedor) return;

    const total = docs.length;
    const aprobadas = docs.filter((d) => d.estado === 'aprobada').length;
    if (contador) contador.textContent = `${aprobadas}/${total}`;

    if (total === 0) {
      contenedor.innerHTML = `<div class="estado-vacio"><span class="emoji-vacio">🧹</span><p>Todavía no tienes tareas asignadas.</p></div>`;
      return;
    }

    const leyenda = `<div class="leyenda-estancias">${Object.entries(ESTANCIA_LABEL).map(([clave, etiqueta]) => `<span class="chip-estancia" data-estancia="${clave}">■ ${etiqueta}</span>`).join('')}</div>`;

    contenedor.innerHTML = leyenda + docs.map((t) => {
      const info = ESTADO_LABEL[t.estado] || ESTADO_LABEL.pendiente;
      let accion = '';
      if (t.estado === 'pendiente') accion = `<button class="btn-accion-hijo" type="button" data-accion="marcar-hecha" data-id="${t.id}">Marcar como hecha</button>`;
      else if (t.estado === 'rechazada') accion = `<button class="btn-accion-hijo" type="button" data-accion="reintentar" data-id="${t.id}">Reintentar</button>`;

      return `
        <div class="tarjeta-tarea" data-estancia="${t.estancia}">
          <div class="tarea-cabecera">
            <strong>${t.titulo}</strong>
            <span class="separador">|</span>
            ${renderizarFechaHora(t)}
            <span class="estado ${info.clase}">${info.texto}</span>
          </div>
          <div class="tarea-detalles">
            <span class="dato"><span class="figura cuadrado">■</span> ${ESTANCIA_LABEL[t.estancia] || t.estancia}</span>
            <span class="dato"><span class="figura circulo">●</span> ${formatearDinero(t.dinero)}</span>
            <span class="dato"><span class="figura triangulo">▲</span> +${t.puntos || 0} Pts</span>
          </div>
          ${accion}
        </div>`;
    }).join('');
  }

  function renderizarMovimientos(docs) {
    const lista = document.querySelector('#pantalla-banco-hijo ul');
    if (!lista) return;
    if (docs.length === 0) {
      lista.innerHTML = `<li style="justify-content:center; color:var(--color-ink-faint);">Aún no hay movimientos</li>`;
      return;
    }
    lista.innerHTML = docs.map((m) => {
      const positivo = (m.importe || 0) >= 0;
      const signo = positivo ? '+' : '';
      return `<li><span>${m.texto}</span><span class="importe ${positivo ? 'positivo' : 'negativo'}">${signo}${formatearDinero(m.importe)}</span></li>`;
    }).join('');
  }

  // Con un solo hijo en la familia todavía no hay "ranking" real: se
  // muestra como un reto personal contra su propia marca. En cuanto se
  // aprueba/entra un segundo hijo, el listener en tiempo real vuelve a
  // llamar a esta función y pasa solo al ranking normal.
  function renderizarRanking(docs) {
    const lista = document.querySelector('#pantalla-banco-hijo ol');
    if (!lista) return;

    if (docs.length === 0) {
      lista.innerHTML = '';
      return;
    }

    if (docs.length === 1) {
      const persona = docs[0];
      lista.innerHTML = `
        <li>
          <span class="puesto">🏆</span>
          <span class="nombre-ranking">Tu mejor marca</span>
          <span class="puntos-ranking">${persona.saldoPuntos || 0} Pts</span>
        </li>`;
      return;
    }

    lista.innerHTML = docs.map((persona, indice) => `
      <li>
        <span class="puesto">${indice + 1}</span>
        <span class="nombre-ranking">${persona.nombre}</span>
        <span class="puntos-ranking">${persona.saldoPuntos || 0} Pts</span>
      </li>`).join('');
  }

  function renderizarSaldos(miembro) {
    const columnas = document.querySelectorAll('#pantalla-banco-hijo .columna-saldo .valor');
    if (columnas[0]) columnas[0].textContent = formatearDinero(miembro.saldoDinero);
    if (columnas[1]) columnas[1].textContent = `${miembro.saldoPuntos || 0} Pts`;
  }

  function renderizarObjetivos(docs) {
    const contenedor = document.querySelector('#pantalla-objetivos-hijo .objetives');
    const contador = document.querySelector('.contador-objetivos');
    if (!contenedor) return;
    if (contador) contador.textContent = `${docs.length}`;

    if (docs.length === 0) {
      contenedor.innerHTML = `<div class="estado-vacio"><span class="emoji-vacio">🎯</span><p>Añade tu primer objetivo de ahorro.</p></div>`;
      return;
    }

    contenedor.innerHTML = docs.map((obj) => {
      const porcentaje = obj.total ? Math.round((obj.actual / obj.total) * 100) : 0;
      return `
        <div class="objetivo-card">
          <div class="name-price">
            <h3>${obj.nombre}</h3>
            <span class="separador">||</span>
            <span class="precio">${formatearDinero(obj.total)}</span>
          </div>
          <progress value="${obj.actual}" max="${obj.total || 1}"></progress>
          <div class="objetivo-progreso-texto">
            <span>${formatearDinero(obj.actual)} ahorrados</span>
            <span>${porcentaje}%</span>
          </div>
        </div>`;
    }).join('');
  }

  /* ================================================================
     9. RENDERIZADO — VISTA PADRE
     ================================================================ */
  function renderizarHijosInicio(hijosAprobados) {
    const contenedor = document.getElementById('lista-hijos-inicio');
    if (!contenedor) return;
    if (hijosAprobados.length === 0) {
      contenedor.innerHTML = `<div class="estado-vacio"><span class="emoji-vacio">👨‍👩‍👧‍👦</span><p>Aún no hay hijos en tu familia. Comparte el código de arriba para que se unan.</p></div>`;
      return;
    }
    contenedor.innerHTML = hijosAprobados.map((h) => `
      <div class="tarjeta-hijo">
        <span class="avatar" style="background:${h.avatarColor || '#00C9A7'}">${(h.nombre || '?').charAt(0).toUpperCase()}</span>
        <div class="info-hijo">
          <strong>${h.nombre}</strong>
          <div class="cifras-hijo">
            <span>💶 ${formatearDinero(h.saldoDinero)}</span>
            <span>⭐ ${h.saldoPuntos || 0} Pts</span>
          </div>
        </div>
      </div>`).join('');
  }

  function renderizarAprobaciones(hijosPendientes) {
    const contenedor = document.getElementById('lista-aprobaciones');
    const banner = document.getElementById('banner-aprobaciones');
    const contadorBanner = document.getElementById('contador-aprobaciones-pendientes');

    if (banner) banner.style.display = hijosPendientes.length ? 'flex' : 'none';
    if (contadorBanner) contadorBanner.textContent = String(hijosPendientes.length);
    if (!contenedor) return;

    if (hijosPendientes.length === 0) {
      contenedor.innerHTML = `<div class="estado-vacio"><span class="emoji-vacio">🎉</span><p>No tienes solicitudes pendientes.</p></div>`;
      return;
    }

    contenedor.innerHTML = hijosPendientes.map((h) => `
      <div class="tarjeta-aprobacion">
        <div class="fila-aprobacion">
          <span class="avatar" style="background:${h.avatarColor || '#00C9A7'}">${(h.nombre || '?').charAt(0).toUpperCase()}</span>
          <div class="info-hijo">
            <strong>${h.nombre}</strong>
            <span>Quiere unirse como ${h.rol === 'padre' ? 'padre/madre' : 'hijo/a'}</span>
          </div>
        </div>
        <div class="acciones-tarea">
          <button class="btn btn-aprobar" type="button" data-accion="aprobar-hijo" data-id="${h.id}">Aprobar</button>
          <button class="btn btn-rechazar" type="button" data-accion="rechazar-hijo" data-id="${h.id}">Rechazar</button>
        </div>
      </div>`).join('');
  }

  function renderizarTareasPadre() {
    const contenedor = document.getElementById('lista-tareas-padre');
    if (!contenedor) return;
    const filtro = ESTADO.filtroTareasPadre;
    const docs = filtro === 'todas' ? ESTADO.tareasFamiliaCache : ESTADO.tareasFamiliaCache.filter((t) => t.estado === filtro);

    if (docs.length === 0) {
      contenedor.innerHTML = `<div class="estado-vacio"><span class="emoji-vacio">📋</span><p>No hay tareas en esta categoría.</p></div>`;
      return;
    }

    contenedor.innerHTML = docs.map((t) => {
      const info = ESTADO_LABEL[t.estado] || ESTADO_LABEL.pendiente;
      const acciones = t.estado === 'revision'
        ? `<div class="acciones-tarea">
             <button class="btn btn-aprobar" type="button" data-accion="aprobar" data-id="${t.id}">Aprobar</button>
             <button class="btn btn-rechazar" type="button" data-accion="rechazar" data-id="${t.id}">Rechazar</button>
           </div>`
        : '';
      return `
        <div class="tarjeta-tarea" data-estancia="${t.estancia}">
          <span class="tarea-hijo">${t.miembroNombre || ''}</span>
          <div class="tarea-cabecera">
            <strong>${t.titulo}</strong>
            <span class="separador">|</span>
            ${renderizarFechaHora(t)}
            <span class="estado ${info.clase}">${info.texto}</span>
          </div>
          <div class="tarea-detalles">
            <span class="dato"><span class="figura cuadrado">■</span> ${ESTANCIA_LABEL[t.estancia] || t.estancia}</span>
            <span class="dato"><span class="figura circulo">●</span> ${formatearDinero(t.dinero)}</span>
            <span class="dato"><span class="figura triangulo">▲</span> +${t.puntos || 0} Pts</span>
          </div>
          ${acciones}
        </div>`;
    }).join('');
  }

  function poblarSelectHijos(hijosAprobados) {
    const select = document.getElementById('hijo-nueva-tarea');
    if (!select) return;
    select.innerHTML = hijosAprobados.map((h) => `<option value="${h.id}" data-nombre="${h.nombre}">${h.nombre}</option>`).join('');
  }

  // Escucha en tiempo real el estado de aprobación de un miembro (hijo o
  // padre) mientras está en la pantalla de espera, y le mete dentro de la
  // app en cuanto alguien lo aprueba — sin que tenga que recargar nada.
  function escucharEstadoAprobacion(familiaId, miembroId) {
    const fRef = db.collection('familias').doc(familiaId);

    const cancelarListener = fRef.collection('miembros').doc(miembroId).onSnapshot(async (doc) => {
      if (!doc.exists) return;
      const datos = doc.data();

      if (datos.aprobado === true) {
        cancelarListener();
        ESTADO.listenersActivos = ESTADO.listenersActivos.filter((fn) => fn !== cancelarListener);

        const familiaDoc = await fRef.get();
        const familiaDatos = familiaDoc.data() || {};
        ESTADO.familiaActual = { id: familiaId, nombre: familiaDatos.nombre, codigo: familiaDatos.codigo };
        ESTADO.miembroActual = { id: miembroId, nombre: datos.nombre, rol: datos.rol };
        mostrarToast(`¡Cuenta aprobada! Bienvenido/a, ${datos.nombre}`, 'exito');

        if (datos.rol === 'padre') {
          iniciarSesionPadre();
          irAPantalla('pantalla-padre-inicio');
        } else {
          iniciarSesionHijo();
          irAPantalla('pantalla-tareas-hijo');
        }
      }
    });

    ESTADO.listenersActivos.push(cancelarListener);
  }

  function iniciarSesionHijo() {
    limpiarListeners();
    const { id: familiaId } = ESTADO.familiaActual;
    const { id: miembroId, nombre } = ESTADO.miembroActual;
    ponerNombreEnCabeceras(PANTALLAS_DASHBOARD_HIJO, nombre);

    const fRef = db.collection('familias').doc(familiaId);

    ESTADO.listenersActivos.push(
      fRef.collection('miembros').doc(miembroId).onSnapshot((doc) => {
        if (doc.exists) renderizarSaldos(doc.data());
      }),
      fRef.collection('tareas').where('miembroId', '==', miembroId).onSnapshot((snap) => {
        const tareas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        tareas.sort((a, b) => `${a.fecha || ''} ${a.hora || ''}`.localeCompare(`${b.fecha || ''} ${b.hora || ''}`));
        renderizarTareasHijo(tareas);
      }),
      fRef.collection('movimientos').where('miembroId', '==', miembroId)
        .orderBy('creadoEn', 'desc').limit(10).onSnapshot((snap) => {
          renderizarMovimientos(snap.docs.map((d) => d.data()));
        }),
      fRef.collection('miembros').where('rol', '==', 'hijo')
        .orderBy('saldoPuntos', 'desc').onSnapshot((snap) => {
          renderizarRanking(snap.docs.map((d) => d.data()));
        }),
      fRef.collection('objetivos').where('miembroId', '==', miembroId).onSnapshot((snap) => {
        renderizarObjetivos(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      })
    );
  }

  function iniciarSesionPadre() {
    limpiarListeners();
    const { id: familiaId, codigo } = ESTADO.familiaActual;
    const { nombre } = ESTADO.miembroActual;
    ponerNombreEnCabeceras(PANTALLAS_DASHBOARD_PADRE, nombre);

    const textoCodigo = document.getElementById('texto-codigo-familia');
    if (textoCodigo) textoCodigo.textContent = codigo ? `NEAT-${codigo}` : '—';

    const fRef = db.collection('familias').doc(familiaId);

    ESTADO.listenersActivos.push(
      fRef.collection('miembros').onSnapshot((snap) => {
        const miembros = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

        const hijosAprobados = miembros.filter((m) => m.rol === 'hijo' && m.aprobado);
        ESTADO.hijosFamiliaCache = hijosAprobados;
        renderizarHijosInicio(hijosAprobados);
        poblarSelectHijos(hijosAprobados);

        // Solicitudes pendientes de aprobación (hijos y también otros padres nuevos)
        const pendientes = miembros.filter((m) => !m.aprobado);
        renderizarAprobaciones(pendientes);
      }),
      fRef.collection('tareas').orderBy('creadoEn', 'desc').onSnapshot((snap) => {
        ESTADO.tareasFamiliaCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderizarTareasPadre();
      })
    );
  }

  /* ================================================================
     11. FORMULARIOS DE REGISTRO
     ================================================================ */
  function inicializarFormulariosBasicos() {
    document.querySelectorAll('.campo-form input').forEach((campo) => {
      campo.addEventListener('input', () => marcarCampoError(campo, false));
    });

    // Registro adulto → guarda datos temporales y pasa a verificación de email
    const formAdulto = document.getElementById('form-registro-adulto');
    formAdulto?.addEventListener('submit', (evento) => {
      evento.preventDefault();
      if (!validarFormulario(formAdulto)) {
        mostrarToast('Revisa los campos marcados en rojo', 'error');
        return;
      }
      ESTADO.registroTemporalAdulto = {
        nombre: document.getElementById('name-adult').value.trim(),
        email: document.getElementById('email-adult').value.trim(),
        password: document.getElementById('password-adult').value,
      };
      mostrarToast('¡Datos guardados! Verifica tu correo', 'exito');
      irAPantalla('pantalla-verificacion-otp');
    });

    // Registro hijo → busca la familia por código, crea el perfil (pendiente
    // de aprobación) y se queda escuchando en tiempo real hasta que el padre lo apruebe.
    const formHijo = document.getElementById('form-registro-hijo');
    formHijo?.addEventListener('submit', async (evento) => {
      evento.preventDefault();
      if (!validarFormulario(formHijo)) {
        mostrarToast('Revisa los campos marcados en rojo', 'error');
        return;
      }
      const nombre = document.getElementById('nombre-hijo').value.trim();
      const pin = document.getElementById('pin-nino').value;
      const campoCodigo = document.getElementById('family-code-hijo');
      const codigo = normalizarCodigo(campoCodigo.value);

      const botonEnviar = formHijo.querySelector('button[type="submit"]');
      botonEnviar.disabled = true;
      try {
        const resultado = await registrarHijo(nombre, pin, codigo);
        if (!resultado) {
          marcarCampoError(campoCodigo, true);
          mostrarToast('No encontramos ninguna familia con ese código', 'error');
          return;
        }
        // 👇 Esta línea es la que faltaba: sin ella, la pantalla de espera
        // nunca se enteraba de que el padre había aprobado al hijo.
        escucharEstadoAprobacion(resultado.familiaId, resultado.miembroId);

        mostrarToast('¡Solicitud enviada a tu familia!', 'exito');
        irAPantalla('pantalla-espera-aprobacion');
      } catch (error) {
        console.error(error);
        mostrarToast('No se pudo completar el registro. Inténtalo de nuevo.', 'error');
      } finally {
        botonEnviar.disabled = false;
      }
    });
  }

  /* ================================================================
     12. CASILLAS OTP Y PIN (auto-avance)
     ================================================================ */
  function inicializarCasillasAutoAvance(selector, alCompletar) {
    const grupos = new Map();
    document.querySelectorAll(selector).forEach((casilla) => {
      const contenedor = casilla.parentElement;
      if (!grupos.has(contenedor)) grupos.set(contenedor, []);
      grupos.get(contenedor).push(casilla);
    });

    grupos.forEach((casillas) => {
      casillas.forEach((casilla, indice) => {
        casilla.addEventListener('input', () => {
          casilla.value = casilla.value.replace(/[^0-9]/g, '').slice(0, 1);
          casilla.classList.toggle('lleno', casilla.value.length === 1);
          if (casilla.value && indice < casillas.length - 1) casillas[indice + 1].focus();
          const completo = casillas.every((c) => c.value.length === 1);
          if (completo && typeof alCompletar === 'function') alCompletar(casillas);
        });
        casilla.addEventListener('keydown', (evento) => {
          if (evento.key === 'Backspace' && !casilla.value && indice > 0) casillas[indice - 1].focus();
        });
      });
    });
  }

  /* ================================================================
     13. CREAR / UNIRSE A FAMILIA
     ================================================================ */
  function inicializarModalesFamilia() {
    const modalCrear = document.getElementById('modal-crear');
    const modalUnirse = document.getElementById('modal-unirse');
    const vistaFormulario = document.getElementById('vista-crear-formulario');
    const vistaExito = document.getElementById('vista-crear-exito');

    document.getElementById('btn-abrir-crear')?.addEventListener('click', () => {
      vistaFormulario.style.display = 'block';
      vistaExito.style.display = 'none';
      modalCrear?.showModal();
    });
    document.getElementById('btn-cerrar-crear')?.addEventListener('click', () => modalCrear?.close());
    document.getElementById('btn-abrir-unirse')?.addEventListener('click', () => modalUnirse?.showModal());
    document.getElementById('btn-cerrar-unirse')?.addEventListener('click', () => modalUnirse?.close());

    document.getElementById('form-crear-familia')?.addEventListener('submit', async (evento) => {
      evento.preventDefault();
      const nombre = document.getElementById('name-family').value.trim();
      const boton = evento.target.querySelector('button[type="submit"]');
      boton.disabled = true;
      try {
        const codigo = await crearFamiliaConAdulto(nombre);
        document.getElementById('texto-codigo-generado').textContent = `NEAT-${codigo}`;
        vistaFormulario.style.display = 'none';
        vistaExito.style.display = 'block';
      } catch (error) {
        console.error(error);
        mostrarToast('No se pudo crear la familia. Inténtalo de nuevo.', 'error');
      } finally {
        boton.disabled = false;
      }
    });

    document.getElementById('btn-cerrar-exito-crear')?.addEventListener('click', () => {
      modalCrear.close();
      mostrarToast('¡Familia creada!', 'exito');
      iniciarSesionPadre();
      irAPantalla('pantalla-padre-inicio');
    });

    document.getElementById('form-unirse-familia')?.addEventListener('submit', async (evento) => {
      evento.preventDefault();
      const campoCodigo = document.getElementById('code-family');
      const codigo = normalizarCodigo(campoCodigo.value);
      const boton = evento.target.querySelector('button[type="submit"]');
      boton.disabled = true;
      try {
        const resultado = await unirsePadreAFamilia(codigo);
        if (!resultado) {
          mostrarToast('No encontramos ninguna familia con ese código', 'error');
          return;
        }
        escucharEstadoAprobacion(resultado.familiaId, resultado.miembroId);
        modalUnirse.close();
        mostrarToast('¡Solicitud enviada a la familia!', 'exito');
        irAPantalla('pantalla-espera-aprobacion');
      } catch (error) {
        console.error(error);
        mostrarToast('No se pudo completar la solicitud. Inténtalo de nuevo.', 'error');
      } finally {
        boton.disabled = false;
      }
    });

    [modalCrear, modalUnirse].forEach((modal) => {
      modal?.addEventListener('click', (evento) => {
        const rect = modal.getBoundingClientRect();
        const dentro = evento.clientX >= rect.left && evento.clientX <= rect.right
          && evento.clientY >= rect.top && evento.clientY <= rect.bottom;
        if (!dentro) modal.close();
      });
    });
  }

  /* ================================================================
     14. LOGIN POR PERFILES
     ================================================================ */
  function renderizarMiembrosGrid(miembros) {
    const grid = document.getElementById('grid-miembros');
    if (!grid) return;
    grid.innerHTML = miembros.map((m) => `
      <button type="button" class="perfil-card" data-miembro="${m.id}">
        <span class="avatar" style="background:${m.avatarColor || '#00C9A7'}">${(m.nombre || '?').charAt(0).toUpperCase()}</span>
        <span class="nombre-perfil">${m.nombre}</span>
        <span class="rol-perfil">${m.rol === 'padre' ? 'Padre/Madre' : 'Hijo/a'}</span>
      </button>`).join('');
  }

  function inicializarLoginPerfiles() {
    const paso1 = document.getElementById('paso-1');
    const paso2 = document.getElementById('paso-2');
    const modalLogin = document.getElementById('modal-login');
    let miembrosEncontrados = [];

    document.getElementById('btn-buscar')?.addEventListener('click', async () => {
      const campoCodigo = document.getElementById('code-family-search');
      const codigo = normalizarCodigo(campoCodigo?.value);
      const boton = document.getElementById('btn-buscar');
      if (!codigo) {
        mostrarToast('Escribe el código de tu familia', 'error');
        return;
      }
      boton.disabled = true;
      try {
        const familia = await buscarFamiliaPorCodigo(codigo);
        if (!familia) {
          mostrarToast('No encontramos ninguna familia con ese código', 'error');
          return;
        }
        ESTADO.familiaActual = { id: familia.id, nombre: familia.nombre, codigo: familia.codigo };
        miembrosEncontrados = await cargarMiembros(familia.id);
        renderizarMiembrosGrid(miembrosEncontrados);
        paso1?.classList.add('oculto');
        paso2?.classList.add('activo');
        mostrarToast('¡Familia encontrada!', 'exito');
      } catch (error) {
        console.error(error);
        mostrarToast('No se pudo buscar la familia. Inténtalo de nuevo.', 'error');
      } finally {
        boton.disabled = false;
      }
    });

    document.getElementById('btn-atras-paso1')?.addEventListener('click', () => {
      paso2?.classList.remove('activo');
      paso1?.classList.remove('oculto');
      const campoCodigo = document.getElementById('code-family-search');
      if (campoCodigo) campoCodigo.value = '';
    });

    document.getElementById('grid-miembros')?.addEventListener('click', (evento) => {
      const tarjeta = evento.target.closest('.perfil-card');
      if (!tarjeta) return;
      const miembro = miembrosEncontrados.find((m) => m.id === tarjeta.dataset.miembro);
      abrirModalLogin(miembro);
    });

    document.getElementById('btn-cerrar-modal')?.addEventListener('click', () => modalLogin?.close());

    const formAuth = document.getElementById('form-autenticacion');
    formAuth?.addEventListener('submit', async (evento) => {
      evento.preventDefault();
      const miembro = ESTADO.perfilSeleccionado;
      if (!miembro) return;

      const esHijo = miembro.rol === 'hijo';
      const secreto = esHijo
        ? Array.from(document.querySelectorAll('#modo-pin .pin-box')).map((c) => c.value).join('')
        : document.getElementById('input-pass-normal').value;

      const hashIntroducido = await hashTexto(secreto);
      if (hashIntroducido !== miembro.secretoHash) {
        mostrarToast(esHijo ? 'PIN incorrecto' : 'Contraseña incorrecta', 'error');
        return;
      }
      if (!miembro.aprobado) {
        mostrarToast('Esta cuenta todavía está pendiente de aprobación', 'error');
        return;
      }

      modalLogin?.close();
      ESTADO.miembroActual = { id: miembro.id, nombre: miembro.nombre, rol: miembro.rol };
      if (esHijo) {
        mostrarToast(`¡Hola, ${miembro.nombre}!`, 'exito');
        iniciarSesionHijo();
        irAPantalla('pantalla-tareas-hijo');
      } else {
        mostrarToast(`¡Bienvenido/a, ${miembro.nombre}!`, 'exito');
        iniciarSesionPadre();
        irAPantalla('pantalla-padre-inicio');
      }
    });
  }

  function abrirModalLogin(miembro) {
    if (!miembro) return;
    ESTADO.perfilSeleccionado = miembro;
    const modal = document.getElementById('modal-login');
    const modoPin = document.getElementById('modo-pin');
    const modoPassword = document.getElementById('modo-password');
    const nombreEl = document.getElementById('modal-nombre');
    const emojiEl = document.getElementById('modal-emoji');
    const instruccionEl = document.getElementById('modal-instruccion');
    const botonMostrarPin = document.querySelector('.btn-mostrar-pin-boxes');

    nombreEl.textContent = `Hola, ${miembro.nombre}`;
    if (miembro.rol === 'hijo') {
      emojiEl.textContent = '🔐';
      instruccionEl.textContent = 'Introduce tu PIN de 4 dígitos para entrar.';
      modoPin.style.display = 'flex';
      if (botonMostrarPin) botonMostrarPin.style.display = 'block';
      modoPassword.style.display = 'none';
      modoPin.querySelectorAll('.pin-box').forEach((c) => { c.value = ''; c.type = 'password'; c.classList.remove('lleno'); });
      if (botonMostrarPin) botonMostrarPin.textContent = '👁️ Mostrar PIN';
      setTimeout(() => modoPin.querySelector('.pin-box')?.focus(), 150);
    } else {
      emojiEl.textContent = '⚡';
      instruccionEl.textContent = 'Introduce tu contraseña para entrar.';
      modoPin.style.display = 'none';
      if (botonMostrarPin) botonMostrarPin.style.display = 'none';
      modoPassword.style.display = 'block';
      const inputPass = document.getElementById('input-pass-normal');
      if (inputPass) { inputPass.value = ''; inputPass.type = 'password'; }
      setTimeout(() => document.getElementById('input-pass-normal')?.focus(), 150);
    }
    modal.showModal();
  }

  /* ================================================================
     15. PANTALLAS DEL PADRE — interacciones
     ================================================================ */
  function inicializarPanelPadre() {
    document.getElementById('btn-copiar-codigo')?.addEventListener('click', () => {
      const textoCompleto = document.getElementById('texto-codigo-familia')?.textContent || '';
      const codigoSoloNumeros = textoCompleto.replace('NEAT-', '').trim();
      navigator.clipboard?.writeText(codigoSoloNumeros).then(() => {
        mostrarToast('¡Código copiado al portapapeles!', 'exito');
      }).catch(() => {
        mostrarToast(codigoSoloNumeros, 'info');
      });
    });

    document.getElementById('filtro-tareas-padre')?.addEventListener('click', (evento) => {
      const boton = evento.target.closest('.filtro-tab');
      if (!boton) return;
      document.querySelectorAll('#filtro-tareas-padre .filtro-tab').forEach((b) => b.classList.remove('activo'));
      boton.classList.add('activo');
      ESTADO.filtroTareasPadre = boton.dataset.filtro;
      renderizarTareasPadre();
    });

    const modalNuevaTarea = document.getElementById('modal-nueva-tarea');
    document.getElementById('btn-nueva-tarea')?.addEventListener('click', () => {
      const hijosAprobados = ESTADO.hijosFamiliaCache.filter((h) => h.aprobado);
      if (hijosAprobados.length === 0) {
        mostrarToast('Todavía no tienes hijos aprobados en tu familia', 'error');
        return;
      }
      poblarSelectHijos(hijosAprobados);
      const campoFecha = document.getElementById('fecha-nueva-tarea');
      if (campoFecha && !campoFecha.value) campoFecha.value = new Date().toISOString().slice(0, 10);
      modalNuevaTarea?.showModal();
    });
    document.getElementById('btn-cerrar-nueva-tarea')?.addEventListener('click', () => modalNuevaTarea?.close());
    modalNuevaTarea?.addEventListener('click', (evento) => {
      const rect = modalNuevaTarea.getBoundingClientRect();
      const dentro = evento.clientX >= rect.left && evento.clientX <= rect.right
        && evento.clientY >= rect.top && evento.clientY <= rect.bottom;
      if (!dentro) modalNuevaTarea.close();
    });

    document.getElementById('form-nueva-tarea')?.addEventListener('submit', async (evento) => {
      evento.preventDefault();
      const selectHijo = document.getElementById('hijo-nueva-tarea');
      const opcionElegida = selectHijo.options[selectHijo.selectedIndex];
      const boton = evento.target.querySelector('button[type="submit"]');
      boton.disabled = true;
      try {
        await crearTareaNueva({
          titulo: document.getElementById('titulo-nueva-tarea').value.trim(),
          estancia: document.getElementById('estancia-nueva-tarea').value,
          miembroId: opcionElegida.value,
          miembroNombre: opcionElegida.dataset.nombre,
          dinero: parseFloat(document.getElementById('dinero-nueva-tarea').value) || 0,
          puntos: parseInt(document.getElementById('puntos-nueva-tarea').value, 10) || 0,
          fecha: document.getElementById('fecha-nueva-tarea').value,
          hora: document.getElementById('hora-nueva-tarea').value,
        });
        modalNuevaTarea.close();
        evento.target.reset();
        mostrarToast('¡Tarea creada!', 'exito');
      } catch (error) {
        console.error(error);
        mostrarToast('No se pudo crear la tarea. Inténtalo de nuevo.', 'error');
      } finally {
        boton.disabled = false;
      }
    });

    document.getElementById('lista-tareas-padre')?.addEventListener('click', async (evento) => {
      const boton = evento.target.closest('[data-accion="aprobar"], [data-accion="rechazar"]');
      if (!boton) return;
      const aprobar = boton.dataset.accion === 'aprobar';
      boton.closest('.acciones-tarea').querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        await resolverTarea(boton.dataset.id, aprobar);
        mostrarToast(aprobar ? '¡Tarea aprobada! Saldo actualizado' : 'Tarea rechazada', aprobar ? 'exito' : 'info');
      } catch (error) {
        console.error(error);
        mostrarToast('No se pudo actualizar la tarea', 'error');
      }
    });

    document.getElementById('lista-aprobaciones')?.addEventListener('click', async (evento) => {
      const boton = evento.target.closest('[data-accion="aprobar-hijo"], [data-accion="rechazar-hijo"]');
      if (!boton) return;
      boton.closest('.acciones-tarea').querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        if (boton.dataset.accion === 'aprobar-hijo') {
          await aprobarHijo(boton.dataset.id);
          mostrarToast('Miembro aprobado/a con éxito', 'exito');
        } else {
          await rechazarHijo(boton.dataset.id);
          mostrarToast('Solicitud rechazada', 'info');
        }
      } catch (error) {
        console.error(error);
        mostrarToast('No se pudo completar la acción', 'error');
      }
    });
  }

  /* ================================================================
     16. ACCIONES DEL HIJO SOBRE SUS TAREAS Y OBJETIVOS
     ================================================================ */
  function inicializarPanelHijo() {
    document.querySelector('#pantalla-tareas-hijo .tareas')?.addEventListener('click', async (evento) => {
      const boton = evento.target.closest('[data-accion="marcar-hecha"], [data-accion="reintentar"]');
      if (!boton) return;
      boton.disabled = true;
      try {
        if (boton.dataset.accion === 'marcar-hecha') {
          await marcarTareaComoHecha(boton.dataset.id);
          mostrarToast('¡Enviado a revisión!', 'exito');
        } else {
          await reintentarTarea(boton.dataset.id);
          mostrarToast('Vuelve a intentarlo, ¡tú puedes!', 'info');
        }
      } catch (error) {
        console.error(error);
        mostrarToast('No se pudo actualizar la tarea', 'error');
      }
    });

    document.querySelector('.cabecera-objetivos button')?.addEventListener('click', async () => {
      const nombre = window.prompt('¿Qué quieres conseguir?');
      if (!nombre) return;
      const totalTexto = window.prompt('¿Cuánto cuesta (en €)?');
      const total = parseFloat((totalTexto || '').replace(',', '.'));
      if (!total || total <= 0) {
        mostrarToast('Introduce un precio válido', 'error');
        return;
      }
      try {
        await crearObjetivoNuevo(nombre, total);
        mostrarToast('¡Objetivo añadido!', 'exito');
      } catch (error) {
        console.error(error);
        mostrarToast('No se pudo añadir el objetivo', 'error');
      }
    });
  }

  /* ================================================================
     17. TRANSFERENCIAS ENTRE MIEMBROS DE LA FAMILIA
     ================================================================ */
  async function poblarSelectDestinatarios() {
    const select = document.getElementById('destinatario-transferencia');
    if (!select || !ESTADO.familiaActual || !ESTADO.miembroActual) return;

    const snapshot = await refFamilia().collection('miembros').get();
    const otros = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((m) => m.id !== ESTADO.miembroActual.id && m.aprobado);

    select.innerHTML = otros.map((m) =>
      `<option value="${m.id}">${m.nombre} (${m.rol === 'padre' ? 'Padre/Madre' : 'Hijo/a'})</option>`
    ).join('');
  }

  async function realizarTransferencia(destinatarioId, tipo, importe) {
    const campoSaldo = tipo === 'dinero' ? 'saldoDinero' : 'saldoPuntos';
    const remitenteRef = refFamilia().collection('miembros').doc(ESTADO.miembroActual.id);
    const destinatarioRef = refFamilia().collection('miembros').doc(destinatarioId);

    const remitenteDoc = await remitenteRef.get();
    const saldoActual = (remitenteDoc.data() || {})[campoSaldo] || 0;
    if (importe > saldoActual) {
      const error = new Error('Saldo insuficiente');
      error.codigo = 'SALDO_INSUFICIENTE';
      throw error;
    }

    const destinatarioDoc = await destinatarioRef.get();
    const nombreDestinatario = (destinatarioDoc.data() || {}).nombre || 'un familiar';
    const etiquetaTipo = tipo === 'dinero' ? '' : ' (puntos)';

    const lote = db.batch();
    lote.update(remitenteRef, { [campoSaldo]: firebase.firestore.FieldValue.increment(-importe) });
    lote.update(destinatarioRef, { [campoSaldo]: firebase.firestore.FieldValue.increment(importe) });

    const movRemitente = refFamilia().collection('movimientos').doc();
    lote.set(movRemitente, {
      miembroId: ESTADO.miembroActual.id,
      texto: `Transferencia a ${nombreDestinatario}${etiquetaTipo}`,
      importe: tipo === 'dinero' ? -importe : 0,
      creadoEn: firebase.firestore.FieldValue.serverTimestamp(),
    });
    const movDestinatario = refFamilia().collection('movimientos').doc();
    lote.set(movDestinatario, {
      miembroId: destinatarioId,
      texto: `Transferencia de ${ESTADO.miembroActual.nombre}${etiquetaTipo}`,
      importe: tipo === 'dinero' ? importe : 0,
      creadoEn: firebase.firestore.FieldValue.serverTimestamp(),
    });

    await lote.commit();
  }

  function inicializarModalTransferencia() {
    const modal = document.getElementById('modal-transferencia');
    const selectorTipo = document.getElementById('tipo-transferencia');
    const campoImporte = document.getElementById('importe-transferencia');
    const mensajeError = document.getElementById('error-transferencia');
    const form = document.getElementById('form-transferencia');
    if (!modal || !form) return;

    document.getElementById('btn-abrir-transferencia')?.addEventListener('click', async () => {
      await poblarSelectDestinatarios();
      selectorTipo.querySelectorAll('.chip-tipo').forEach((chip, indice) => chip.classList.toggle('activo', indice === 0));
      campoImporte.value = '';
      mensajeError.style.display = 'none';
      modal.showModal();
    });

    document.getElementById('btn-cerrar-transferencia')?.addEventListener('click', () => modal.close());
    modal.addEventListener('click', (evento) => {
      const rect = modal.getBoundingClientRect();
      const dentro = evento.clientX >= rect.left && evento.clientX <= rect.right
        && evento.clientY >= rect.top && evento.clientY <= rect.bottom;
      if (!dentro) modal.close();
    });

    selectorTipo?.addEventListener('click', (evento) => {
      const chip = evento.target.closest('.chip-tipo');
      if (!chip) return;
      selectorTipo.querySelectorAll('.chip-tipo').forEach((c) => c.classList.remove('activo'));
      chip.classList.add('activo');
    });

    form.addEventListener('submit', async (evento) => {
      evento.preventDefault();
      const destinatarioId = document.getElementById('destinatario-transferencia').value;
      const tipo = selectorTipo.querySelector('.chip-tipo.activo')?.dataset.tipo || 'dinero';
      const importe = parseFloat(campoImporte.value);

      if (!destinatarioId) {
        mostrarToast('Elige a quién quieres enviarlo', 'error');
        return;
      }
      if (!importe || importe <= 0) {
        mostrarToast('Introduce un importe válido', 'error');
        return;
      }

      mensajeError.style.display = 'none';
      const boton = form.querySelector('button[type="submit"]');
      boton.disabled = true;
      try {
        await realizarTransferencia(destinatarioId, tipo, importe);
        modal.close();
        mostrarToast('¡Transferencia realizada!', 'exito');
      } catch (error) {
        if (error.codigo === 'SALDO_INSUFICIENTE') {
          mensajeError.style.display = 'block';
        } else {
          console.error(error);
          mostrarToast('No se pudo completar la transferencia. Inténtalo de nuevo.', 'error');
        }
      } finally {
        boton.disabled = false;
      }
    });
  }

  /* ================================================================
     18. MOSTRAR / OCULTAR CONTRASEÑAS
     ================================================================ */
  function inicializarMostrarContrasenas() {
    // Campos normales de contraseña/PIN con botón individual (registro adulto,
    // registro hijo, contraseña del login de padres)
    document.querySelectorAll('.btn-mostrar-pass').forEach((boton) => {
      boton.addEventListener('click', () => {
        const campo = document.getElementById(boton.dataset.objetivo);
        if (!campo) return;
        const mostrando = campo.type === 'text';
        campo.type = mostrando ? 'password' : 'text';
        boton.textContent = mostrando ? '👁️' : '🙈';
        boton.classList.toggle('activo', !mostrando);
      });
    });

    // Casillas de PIN de 4 dígitos (login del hijo) — un solo botón para todas
    const botonPinBoxes = document.querySelector('.btn-mostrar-pin-boxes');
    botonPinBoxes?.addEventListener('click', () => {
      const casillas = document.querySelectorAll('#modo-pin .pin-box');
      const mostrando = casillas[0]?.type === 'text';
      casillas.forEach((c) => { c.type = mostrando ? 'password' : 'text'; });
      botonPinBoxes.textContent = mostrando ? '👁️ Mostrar PIN' : '🙈 Ocultar PIN';
    });
  }

  /* ================================================================
     19. ARRANQUE DE LA APP
     ================================================================ */
  document.addEventListener('DOMContentLoaded', () => {
    inicializarNavegacion();
    inicializarFormulariosBasicos();
    inicializarModalesFamilia();
    inicializarLoginPerfiles();
    inicializarPanelPadre();
    inicializarPanelHijo();
    inicializarModalTransferencia();
    inicializarMostrarContrasenas();

    inicializarCasillasAutoAvance('.otp-input', () => {
      mostrarToast('¡Correo verificado!', 'exito');
      setTimeout(() => irAPantalla('pantalla-opcion-familia'), 500);
    });
    inicializarCasillasAutoAvance('.pin-box', () => {
      document.getElementById('form-autenticacion')?.requestSubmit();
    });

    const pantallaCargando = document.getElementById('pantalla-cargando');
    inicializarFirebase()
      .then(() => { firebaseListo = true; })
      .catch(() => { mostrarToast('No se pudo conectar con la base de datos. Revisa firebase-config.js', 'error'); })
      .finally(() => { if (pantallaCargando) pantallaCargando.style.display = 'none'; });
  });
})();