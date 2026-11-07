// ===== TESTIMONIALS DATA =====
const testimonials = [
  {
    initials: "SC",
    name: "Dr. Sarah Chen",
    title: "Urban Planning Director",
    org: "Singapore Smart Nation Initiative",
    location: "Singapore",
    quote:
      "This platform revolutionizes how we monitor urban health. The real-time satellite data integration with AI insights helps us make data-driven decisions for over 5 million residents.",
  },
  {
    initials: "MR",
    name: "Miguel Rodriguez",
    title: "Senior City Planner",
    org: "Barcelona Urban Lab",
    location: "Barcelona, Spain",
    quote:
      "The comprehensive environmental quality monitoring has been instrumental in our sustainability initiatives. We've reduced urban heat islands by 15% using these insights.",
  },
  {
    initials: "AO",
    name: "Prof. Amara Okafor",
    title: "Urban Sustainability Researcher",
    org: "University of Cape Town",
    location: "Cape Town, South Africa",
    quote:
      "Exceptional platform for academic research. The integration of multiple urban health indices provides unprecedented insights into city resilience and social well-being patterns.",
  },
  {
    initials: "DK",
    name: "David Kim",
    title: "Smart Cities Coordinator",
    org: "Seoul Metropolitan Government",
    location: "Seoul, South Korea",
    quote:
      "The disaster preparedness analytics have been game-changing. We can now predict and prepare for environmental risks with 85% accuracy, protecting millions of citizens.",
  },
  {
    initials: "EP",
    name: "Dr. Elena Petrov",
    title: "Climate Resilience Officer",
    org: "Amsterdam Municipality",
    location: "Amsterdam, Netherlands",
    quote:
      "Outstanding air quality monitoring capabilities. The AI-powered recommendations helped us implement targeted policies that improved air quality by 22% in key districts.",
  },
  {
    initials: "JT",
    name: "James Thompson",
    title: "Urban Analytics Manager",
    org: "Transport for London",
    location: "London, UK",
    quote:
      "The real-time urban mobility insights are invaluable. We've optimized traffic flow and reduced emissions by integrating this platform with our transportation planning.",
  },
  {
    initials: "PS",
    name: "Dr. Priya Sharma",
    title: "Environmental Planning Consultant",
    org: "Mumbai Development Authority",
    location: "Mumbai, India",
    quote:
      "Incredible social well-being metrics that help us understand community needs. The platform's accessibility and comprehensive data have transformed our urban planning approach.",
  },
  {
    initials: "CM",
    name: "Carlos Mendoza",
    title: "Disaster Risk Management",
    org: "Mexico City Government",
    location: "Mexico City, Mexico",
    quote:
      "The early warning systems powered by this platform have helped us evacuate communities ahead of environmental disasters, potentially saving thousands of lives.",
  },
];

// ===== NAVIGATION SYSTEM =====
const sections = ['welcome', 'dashboard', '3d', 'map', 'usecases', 'chatbot'];
let currentSection = 'welcome';

function initNavigation() {
  const navBtns = document.querySelectorAll('.nav-btn');
  
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetSection = btn.getAttribute('data-section');
      navigateToSection(targetSection);
    });
  });

  // Logo click → home
  const logo = document.querySelector('.logo');
  if (logo) {
    logo.addEventListener('click', (e) => {
      e.preventDefault();
      navigateToSection('welcome');
    });
  }

  // Start Analysis button
  const startBtn = document.getElementById('startAnalysisBtn');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      navigateToSection('dashboard');
    });
  }
}

function navigateToSection(sectionName) {
  // Hide all sections
  document.querySelectorAll('.section').forEach(section => {
    section.classList.remove('active');
  });

  // Remove active class from all nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  // Show target section
  const targetSection = document.getElementById(`${sectionName}-section`);
  if (targetSection) {
    targetSection.classList.add('active');
  }

  // Activate nav button
  const activeBtn = document.querySelector(`[data-section="${sectionName}"]`);
  if (activeBtn) {
    activeBtn.classList.add('active');
  }

  currentSection = sectionName;

  // Trigger section-specific initialization
  if (sectionName === 'dashboard') {
    initDashboard();
  } else if (sectionName === '3d') {
    init3DView();
  } else if (sectionName === 'chatbot') {
    initChatbot();
  }
}

// ===== TESTIMONIALS SLIDER =====
const wrapper = document.querySelector(".testimonial-wrapper");
const dotsContainer = document.getElementById("sliderDots");

let currentIndex = 0;

function renderSlides() {
  if (!wrapper || !dotsContainer || !testimonials.length) return;
  wrapper.innerHTML = "";
  dotsContainer.innerHTML = "";

  testimonials.forEach((t, index) => {
    const card = document.createElement("article");
    card.className = "testimonial-card";
    card.innerHTML = `
      <div class="testimonial-quote-mark" aria-hidden="true">“</div>
      <div class="testimonial-rating" aria-label="5 out of 5 stars">
        <span>★</span><span>★</span><span>★</span><span>★</span><span>★</span>
      </div>
      <p class="testimonial-quote">${t.quote}</p>
      <div class="testimonial-meta">
        <div class="initials" aria-hidden="true">${t.initials}</div>
        <div class="meta-text">
          <div class="name">${t.name}</div>
          <div class="title">${t.title}</div>
          <div class="location">${t.org} • ${t.location}</div>
        </div>
      </div>
    `;
    wrapper.appendChild(card);

    const dot = document.createElement("button");
    dot.className = "dot" + (index === 0 ? " active" : "");
    dot.setAttribute("aria-label", `Go to testimonial ${index + 1}`);
    dot.addEventListener("click", () => goToSlide(index));
    dotsContainer.appendChild(dot);
  });
}

function updateSlider() {
  const offset = -currentIndex * 100;
  wrapper.style.transform = `translateX(${offset}%)`;
  const dots = document.querySelectorAll(".dot");
  dots.forEach((d, i) => {
    d.classList.toggle("active", i === currentIndex);
  });
}

function goToSlide(index) {
  if (!testimonials.length || !wrapper) return;
  currentIndex = (index + testimonials.length) % testimonials.length;
  updateSlider();
}

document.getElementById("prevBtn")?.addEventListener("click", () => {
  goToSlide(currentIndex - 1);
});

document.getElementById("nextBtn")?.addEventListener("click", () => {
  goToSlide(currentIndex + 1);
});

// ===== GLOBAL APP STATE =====
const appState = {
  currentLocation: {
    lat: 23.8103,
    lng: 90.4125,
    name: 'Dhaka, Bangladesh'
  },
  healthData: null,
  isLoading: false
};

// ===== INITIALIZE APP =====
function initApp() {
  console.log('🌍 Initializing LUPUS CORTEX Urban Intelligence Platform...');
  
  initNavigation();
  renderSlides();

  // Auto-rotate testimonials (pauses on hover/focus)
  const slider = document.querySelector('.testimonial-slider');
  let testimonialTimer = setInterval(() => goToSlide(currentIndex + 1), 7000);
  const pauseAuto = () => { clearInterval(testimonialTimer); testimonialTimer = null; };
  const resumeAuto = () => {
    if (!testimonialTimer) testimonialTimer = setInterval(() => goToSlide(currentIndex + 1), 7000);
  };
  if (slider) {
    slider.addEventListener('mouseenter', pauseAuto);
    slider.addEventListener('mouseleave', resumeAuto);
    slider.addEventListener('focusin', pauseAuto);
    slider.addEventListener('focusout', resumeAuto);
  }

  // Feature-card spotlight follows cursor
  document.querySelectorAll('.feature-card').forEach((card) => {
    card.addEventListener('mousemove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });

  console.log('✅ App initialized successfully!');
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// ===== INTERACTIVE HERO GLOBE (Three.js) =====
function initHeroGlobe() {
  const canvas = document.getElementById('heroGlobe');
  if (!canvas || typeof THREE === 'undefined') {
    console.warn('Hero globe: canvas or THREE not available');
    return;
  }

  const stage = canvas.parentElement;

  // Scene setup
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0, 3.2);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(5, 3, 5);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x38bdf8, 0.6);
  rim.position.set(-5, -2, -3);
  scene.add(rim);

  // Earth
  const loader = new THREE.TextureLoader();
  loader.crossOrigin = 'anonymous';

  const earthGeo = new THREE.SphereGeometry(1, 64, 64);
  const earthMat = new THREE.MeshPhongMaterial({
    color: 0x2a4a7f,
    specular: 0x222233,
    shininess: 18,
  });
  const earth = new THREE.Mesh(earthGeo, earthMat);
  scene.add(earth);

  // Try loading a real Earth texture (fallback to procedural look on failure)
  const textureUrls = [
    'https://raw.githubusercontent.com/mrdoob/three.js/r128/examples/textures/planets/earth_atmos_2048.jpg',
    'https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg',
  ];
  (function tryLoad(i) {
    if (i >= textureUrls.length) return;
    loader.load(
      textureUrls[i],
      (tex) => {
        earthMat.map = tex;
        earthMat.color.set(0xffffff);
        earthMat.needsUpdate = true;
      },
      undefined,
      () => tryLoad(i + 1)
    );
  })(0);

  // Subtle cloud layer
  const cloudGeo = new THREE.SphereGeometry(1.015, 48, 48);
  const cloudMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  });
  const clouds = new THREE.Mesh(cloudGeo, cloudMat);
  scene.add(clouds);

  // Atmospheric glow (back-side sphere with additive blending)
  const atmoGeo = new THREE.SphereGeometry(1.12, 48, 48);
  const atmoMat = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    uniforms: { glowColor: { value: new THREE.Color(0x38bdf8) } },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      uniform vec3 glowColor;
      void main() {
        float intensity = pow(0.65 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.2);
        gl_FragColor = vec4(glowColor, 1.0) * intensity;
      }
    `,
  });
  const atmosphere = new THREE.Mesh(atmoGeo, atmoMat);
  scene.add(atmosphere);

  // Starfield
  const starGeo = new THREE.BufferGeometry();
  const starCount = 600;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 30 + Math.random() * 20;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    starPos[i * 3 + 2] = r * Math.cos(phi);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(
    starGeo,
    new THREE.PointsMaterial({ color: 0xffffff, size: 0.08, sizeAttenuation: true })
  );
  scene.add(stars);

  // ----- Interaction: drag to rotate, wheel to zoom -----
  const state = {
    targetRotX: 0.15,
    targetRotY: 0,
    rotX: 0.15,
    rotY: 0,
    isDragging: false,
    lastX: 0,
    lastY: 0,
    zoom: 3.2,
    targetZoom: 3.2,
    autoRotate: true,
    idleTimer: 0,
  };

  function onPointerDown(e) {
    state.isDragging = true;
    state.autoRotate = false;
    const p = e.touches ? e.touches[0] : e;
    state.lastX = p.clientX;
    state.lastY = p.clientY;
    canvas.style.cursor = 'grabbing';
  }
  function onPointerMove(e) {
    if (!state.isDragging) return;
    const p = e.touches ? e.touches[0] : e;
    const dx = p.clientX - state.lastX;
    const dy = p.clientY - state.lastY;
    state.lastX = p.clientX;
    state.lastY = p.clientY;
    state.targetRotY += dx * 0.005;
    state.targetRotX += dy * 0.005;
    state.targetRotX = Math.max(-1.2, Math.min(1.2, state.targetRotX));
    state.idleTimer = 0;
  }
  function onPointerUp() {
    state.isDragging = false;
    canvas.style.cursor = 'grab';
  }
  function onWheel(e) {
    e.preventDefault();
    state.targetZoom += e.deltaY * 0.002;
    state.targetZoom = Math.max(1.6, Math.min(6, state.targetZoom));
  }

  canvas.style.cursor = 'grab';
  canvas.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);
  canvas.addEventListener('touchstart', onPointerDown, { passive: true });
  window.addEventListener('touchmove', onPointerMove, { passive: true });
  window.addEventListener('touchend', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // Animate
  const clock = new THREE.Clock();
  function animate() {
    const dt = clock.getDelta();

    // Resume auto-rotate after idle
    if (!state.isDragging) {
      state.idleTimer += dt;
      if (state.idleTimer > 2.5) state.autoRotate = true;
    }
    if (state.autoRotate) {
      state.targetRotY += dt * 0.12;
    }

    // Smooth interpolation
    state.rotX += (state.targetRotX - state.rotX) * 0.1;
    state.rotY += (state.targetRotY - state.rotY) * 0.1;
    state.zoom += (state.targetZoom - state.zoom) * 0.1;

    earth.rotation.x = state.rotX;
    earth.rotation.y = state.rotY;
    clouds.rotation.x = state.rotX;
    clouds.rotation.y = state.rotY + dt * 0.02 + clouds.rotation.y * 0; // tiny drift
    clouds.rotation.y = state.rotY * 1.02;
    atmosphere.rotation.copy(earth.rotation);
    stars.rotation.y += dt * 0.005;

    camera.position.z = state.zoom;

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate();
}

// Initialize globe after DOM ready (and after THREE is available)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHeroGlobe);
} else {
  initHeroGlobe();
}

// ===== CANONICAL ANALYSIS UI =====
(function wireAnalysisUI() {
  const statusMode = document.getElementById('analysisStatusMode');
  const statusLocation = document.getElementById('analysisStatusLocation');
  const statusMeta = document.getElementById('analysisStatusMeta');
  const refresh = document.getElementById('refreshAnalysisBtn');
  const footerYear = document.getElementById('footerYear');
  if (footerYear) footerYear.textContent = new Date().getFullYear();

  function setStatus(mode, location, meta, state) {
    if (statusMode) statusMode.textContent = mode;
    if (statusLocation) statusLocation.textContent = location;
    if (statusMeta) statusMeta.textContent = meta;
    const bar = document.getElementById('analysisStatusBar');
    if (bar) bar.dataset.state = state;
  }

  window.addEventListener('cortex:analysis-state', event => {
    const state = event.detail;
    if (state.status === 'awaiting_model') {
      setStatus('ANALYSIS REQUESTED', `${state.request.name} | ${state.request.lat.toFixed(4)}, ${state.request.lon.toFixed(4)}`, 'Awaiting the model report. No environmental values are shown until the report includes evidence.', 'pending');
    }
  });
  window.addEventListener('cortex:analysis-error', event => setStatus('ANALYSIS UNAVAILABLE', event.detail.request?.name || 'Selected location', event.detail.error || 'The analysis request could not be completed.', 'error'));
  window.addEventListener('cortex:analysis-ready', event => {
    const report = event.detail;
    const quality = report.data_quality || {};
    const location = report.location || {};
    setStatus('CURRENT ANALYSIS', `${location.name || 'Selected location'} | ${Number(location.lat).toFixed(4)}, ${Number(location.lon ?? location.lng).toFixed(4)}`, `Coverage: ${quality.coverage ?? '—'}% | Observed: ${quality.observed ?? '—'} | Latest valid: ${quality.latest_valid ?? '—'} | Estimated: ${quality.estimated ?? '—'}`, 'ready');
    if (typeof renderDashboardFromAnalysis === 'function') renderDashboardFromAnalysis(report);
  });
  if (refresh) refresh.addEventListener('click', () => window.CortexAnalysis?.request?.(appState.currentLocation));
}());
