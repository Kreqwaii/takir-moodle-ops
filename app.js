'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const VIEW_TITLES = {
    cutover: 'План переезда и обновления Moodle 4.4 -> 5.3 LTS',
    compat: 'Матрица совместимости PHP 8.3, MariaDB и плагинов',
    backups: 'Резервное копирование 3-2-1 и калькулятор RPO',
    sla: 'SLA, мониторинг cron и контроль качества',
  };

  const CUTOVER_STEPS = [
    {
      id: 1,
      title: 'Изоляция СДО и консистентный снапшот на старом узле',
      duration: '15-20 мин',
      tag: 'Этап 1',
      desc: 'Перевод портала edu.takir.ru в режим обслуживания, фиксация активных сессий слушателей ДПО и снятие консистентного дампа базы данных вместе с каталогом moodledata.',
      cli: [
        '# 1. Включение режима обслуживания на текущем узле',
        'sudo -u www-data php /var/www/moodle/admin/cli/maintenance.php --enable',
        '',
        '# 2. Консистентный дамп базы данных',
        'mysqldump --single-transaction --routines --triggers --quick \\',
        '  -u moodle_admin -p moodle_takir | zstd -T0 -3 > /backup/moodle_takir_$(date +%F_%H%M).sql.zst',
        '',
        '# 3. Первичная синхронизация moodledata',
        'rsync -aHAX --info=progress2 /var/moodledata/ root@new-node.takir.ru:/var/moodledata/',
      ].join('\n'),
    },
    {
      id: 2,
      title: 'Развертывание целевого окружения под Moodle 5.3 LTS',
      duration: '20-30 мин',
      tag: 'Этап 2',
      desc: 'Подготовка чистого сервера на Ubuntu 24.04 LTS: установка Nginx, PHP 8.3-FPM с необходимыми расширениями (sodium, intl, soap, opcache), MariaDB 10.11 в utf8mb4_unicode_ci и Redis 7.',
      cli: [
        '# Проверка версии PHP и обязательных модулей',
        'php -v',
        'php -m | grep -E "sodium|intl|soap|opcache|redis|mysqli|xml|zip|gd"',
        '',
        '# Ключевые параметры /etc/php/8.3/fpm/php.ini',
        'max_input_vars = 5000',
        'memory_limit = 512M',
        'upload_max_filesize = 256M',
        'post_max_size = 256M',
        '',
        '# Проверка MariaDB 10.11 и Redis 7',
        'mariadb --version',
        'redis-cli ping',
      ].join('\n'),
    },
    {
      id: 3,
      title: 'Перенос БД и каталога moodledata на новый хостинг',
      duration: '15-30 мин',
      tag: 'Этап 3',
      desc: 'Разворачивание сжатого дампа в MariaDB 10.11, настройка прав 02770 на каталог moodledata и актуализация путей, параметров Redis и $CFG->wwwroot в config.php.',
      cli: [
        '# Импорт дампа в целевую БД',
        'zstd -dc /backup/moodle_takir_latest.sql.zst | mariadb -u moodle_admin -p moodle_takir',
        '',
        '# Назначение прав на moodledata',
        'chown -R www-data:www-data /var/moodledata',
        'chmod -R 02770 /var/moodledata',
        '',
        '# Проверка синтаксиса config.php',
        'php -l /var/www/moodle/config.php',
      ].join('\n'),
    },
    {
      id: 4,
      title: 'Аудит плагинов ДПО, тестов и маршрута обновления 4.4 -> 4.5 LTS -> 5.3 LTS',
      duration: '15 мин',
      tag: 'Этап 4',
      desc: 'Проверка совместимости кастомных плагинов сертификатов и тем оформления, адаптация корневой директории public/ для Moodle 5.x и запуск встроенной диагностики среды.',
      cli: [
        '# Переход на промежуточный релиз 4.5 LTS и проверка зависимостей',
        'sudo -u www-data php /var/www/moodle/admin/cli/checks.php',
        '',
        '# Список сторонних плагинов для сверки версий',
        'sudo -u www-data php /var/www/moodle/admin/cli/uninstall_plugins.php --show-contrib',
        '',
        '# Проверка корневой точки входа Nginx для Moodle 5.3 LTS',
        'ls -la /var/www/moodle/public/index.php',
      ].join('\n'),
    },
    {
      id: 5,
      title: 'Неинтерактивное CLI-обновление ядра и прогрев Redis-кэша',
      duration: '10-15 мин',
      tag: 'Этап 5',
      desc: 'Выполнение миграций базы данных через CLI без таймаутов веб-сервера, очистка и прогрев MUC-кэша в Redis 7, а также запуск системного таймера moodle-cron.timer с интервалом 60 секунд.',
      cli: [
        '# Неинтерактивное обновление ядра Moodle 5.3 LTS',
        'sudo -u www-data php /var/www/moodle/admin/cli/upgrade.php --non-interactive',
        '',
        '# Сброс и прогрев кэша',
        'sudo -u www-data php /var/www/moodle/admin/cli/purge_caches.php',
        '',
        '# Активация systemd-таймера планировщика (каждые 60 сек)',
        'systemctl enable --now moodle-cron.timer',
        'systemctl status moodle-cron.timer --no-pager',
      ].join('\n'),
    },
    {
      id: 6,
      title: 'Финальная дельта-синхронизация, выпуск SSL и переключение DNS edu.takir.ru',
      duration: '<= 20 мин',
      tag: 'Этап 6',
      desc: 'Понижение TTL DNS-записи, финальный догон дельты moodledata, выпуск сертификата Let\'s Encrypt, отключение режима обслуживания и контрольный вход методиста.',
      cli: [
        '# Финальная дельта-синхронизация moodledata',
        'rsync -aHAX --delete /var/moodledata/ root@new-node.takir.ru:/var/moodledata/',
        '',
        '# Выпуск SSL-сертификата для edu.takir.ru',
        'certbot --nginx -d edu.takir.ru --non-interactive --agree-tos -m ops@takir.ru',
        '',
        '# Вывод СДО из режима обслуживания',
        'sudo -u www-data php /var/www/moodle/admin/cli/maintenance.php --disable',
      ].join('\n'),
    },
  ];

  const COMPAT_ITEMS = [
    {
      category: 'php',
      component: 'PHP 8.3.12 + sodium/intl',
      requirement: 'PHP >= 8.2, обязательные модули sodium, intl, soap, opcache',
      status: 'Готово',
      tagClass: 'tag-ok',
      note: 'Проверено на целевом образе Ubuntu 24.04 LTS',
    },
    {
      category: 'php',
      component: 'php.ini max_input_vars = 5000',
      requirement: 'Минимум 5000 для корректного сохранения крупных тестов и ведомостей',
      status: 'Готово',
      tagClass: 'tag-ok',
      note: 'Применено в /etc/php/8.3/fpm/php.ini',
    },
    {
      category: 'php',
      component: 'Структура каталога public/ в Moodle 5.1+',
      requirement: 'DocumentRoot Nginx должен указывать на /var/www/moodle/public',
      status: 'Настройка',
      tagClass: 'tag-act',
      note: 'Шаблон server-блока Nginx подготовлен',
    },
    {
      category: 'db',
      component: 'MariaDB 10.11 Barracuda / utf8mb4',
      requirement: 'innodb_file_per_table = 1, utf8mb4_unicode_ci',
      status: 'Готово',
      tagClass: 'tag-ok',
      note: 'Совместимость подтверждена через checks.php',
    },
    {
      category: 'db',
      component: 'Индексы mdl_logstore_standard_log',
      requirement: 'Проверка фрагментации и времени выборки отчетов ДПО',
      status: 'Готово',
      tagClass: 'tag-ok',
      note: 'Оптимизация выполняется автоматически при импорте',
    },
    {
      category: 'plugins',
      component: 'Маршрут обновления 4.4 -> 4.5 LTS -> 5.3 LTS',
      requirement: 'Поэтапный проход через промежуточный LTS-релиз',
      status: 'План',
      tagClass: 'tag-act',
      note: 'Исключает ошибки миграции схемы БД',
    },
    {
      category: 'plugins',
      component: 'Модули генерации удостоверений ДПО и тестов',
      requirement: 'Совместимость с PHP 8.3 и API Moodle 5.3',
      status: 'Аудит',
      tagClass: 'tag-act',
      note: 'Тестируется на staging-стенде перед cutover',
    },
    {
      category: 'db',
      component: 'Сессии и MUC-кэш в Redis 7',
      requirement: 'Отдельные prefix-пространства для session и application cache',
      status: 'Готово',
      tagClass: 'tag-ok',
      note: 'Снижает нагрузку на диск и MariaDB',
    },
  ];

  // 1. Sidebar View Switcher & Mobile Toggle
  const navItems = Array.from(document.querySelectorAll('.nav-item[data-view]'));
  const viewTitleEl = document.getElementById('viewTitle');
  const mobileNavBtn = document.getElementById('mobileNavBtn');
  const opsSidebar = document.getElementById('opsSidebar');
  const panels = {
    cutover: document.getElementById('panel-cutover'),
    compat: document.getElementById('panel-compat'),
    backups: document.getElementById('panel-backups'),
    sla: document.getElementById('panel-sla'),
  };

  function switchView(viewKey) {
    if (!panels[viewKey]) return;
    navItems.forEach((btn) => {
      const isTarget = btn.dataset.view === viewKey;
      btn.classList.toggle('is-active', isTarget);
    });
    Object.entries(panels).forEach(([key, panelEl]) => {
      if (!panelEl) return;
      panelEl.hidden = key !== viewKey;
    });
    if (viewTitleEl && VIEW_TITLES[viewKey]) {
      viewTitleEl.textContent = VIEW_TITLES[viewKey];
    }
    if (opsSidebar) {
      opsSidebar.classList.remove('is-open');
    }
  }

  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetView = btn.dataset.view;
      if (targetView) switchView(targetView);
    });
  });

  if (mobileNavBtn && opsSidebar) {
    mobileNavBtn.addEventListener('click', () => {
      opsSidebar.classList.toggle('is-open');
    });
  }

  // 2. 6-Step Interactive Cutover Runbook
  const stepsListEl = document.getElementById('cutoverStepsList');
  const stepDetailTitleEl = document.getElementById('stepDetailTitle');
  const stepDurationTagEl = document.getElementById('stepDurationTag');
  const stepDetailDescEl = document.getElementById('stepDetailDesc');
  const cliPreviewBoxEl = document.getElementById('cliPreviewBox');
  let activeStepId = 1;

  function renderStepDetail(step) {
    if (!step) return;
    if (stepDetailTitleEl) stepDetailTitleEl.textContent = `${step.id}. ${step.title}`;
    if (stepDurationTagEl) stepDurationTagEl.textContent = step.duration;
    if (stepDetailDescEl) stepDetailDescEl.textContent = step.desc;
    if (cliPreviewBoxEl) cliPreviewBoxEl.textContent = step.cli;
  }

  function renderStepsList() {
    if (!stepsListEl) return;
    stepsListEl.innerHTML = '';
    CUTOVER_STEPS.forEach((step) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `step-row${step.id === activeStepId ? ' is-active' : ''}`;

      const top = document.createElement('div');
      top.className = 'step-row-top';

      const titleSpan = document.createElement('span');
      titleSpan.textContent = `${step.id}. ${step.title}`;

      const tagSpan = document.createElement('span');
      tagSpan.className = `status-tag ${step.id === activeStepId ? 'tag-act' : 'tag-ok'}`;
      tagSpan.textContent = step.duration;

      top.appendChild(titleSpan);
      top.appendChild(tagSpan);

      const sub = document.createElement('div');
      sub.className = 'step-row-sub';
      sub.textContent = step.desc;

      btn.appendChild(top);
      btn.appendChild(sub);

      btn.addEventListener('click', () => {
        activeStepId = step.id;
        renderStepsList();
        renderStepDetail(step);
      });

      stepsListEl.appendChild(btn);
    });
  }

  if (stepsListEl) {
    renderStepsList();
    renderStepDetail(CUTOVER_STEPS[0]);
  }

  // 3. Compatibility Matrix
  const compatFilterBar = document.getElementById('compatFilterBar');
  const compatTableBody = document.getElementById('compatTableBody');
  const runCheckSimBtn = document.getElementById('runCheckSimBtn');
  let activeCompatFilter = 'all';

  function renderCompatTable(filter) {
    if (!compatTableBody) return;
    const rows = filter === 'all'
      ? COMPAT_ITEMS
      : COMPAT_ITEMS.filter((item) => item.category === filter);

    compatTableBody.innerHTML = '';
    rows.forEach((item) => {
      const tr = document.createElement('tr');

      const tdComp = document.createElement('td');
      tdComp.textContent = item.component;

      const tdReq = document.createElement('td');
      tdReq.textContent = item.requirement;

      const tdStatus = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = `status-tag ${item.tagClass}`;
      badge.textContent = item.status;
      tdStatus.appendChild(badge);

      const tdNote = document.createElement('td');
      tdNote.textContent = item.note;

      tr.appendChild(tdComp);
      tr.appendChild(tdReq);
      tr.appendChild(tdStatus);
      tr.appendChild(tdNote);
      compatTableBody.appendChild(tr);
    });
  }

  if (compatFilterBar) {
    const filterButtons = Array.from(compatFilterBar.querySelectorAll('[data-filter]'));
    filterButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        activeCompatFilter = btn.dataset.filter || 'all';
        filterButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
        renderCompatTable(activeCompatFilter);
      });
    });
  }

  if (runCheckSimBtn) {
    runCheckSimBtn.addEventListener('click', () => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      runCheckSimBtn.textContent = `Проверено в ${hh}:${mm}:${ss}`;
      renderCompatTable(activeCompatFilter);
    });
  }

  if (compatTableBody) {
    renderCompatTable('all');
  }

  // 4. 3-2-1 Backup & RPO Calculator
  const studentsRange = document.getElementById('studentsRange');
  const storageRange = document.getElementById('storageRange');
  const studentsVal = document.getElementById('studentsVal');
  const storageVal = document.getElementById('storageVal');
  const backupCalcOutput = document.getElementById('backupCalcOutput');

  function updateBackupCalc() {
    if (!studentsRange || !storageRange || !backupCalcOutput) return;
    const students = Number(studentsRange.value) || 0;
    const storageGb = Number(storageRange.value) || 0;

    if (studentsVal) studentsVal.textContent = `${students} слушателей`;
    if (storageVal) storageVal.textContent = `${storageGb} ГБ`;

    const dbRawGb = Math.max(1.2, students * 0.0025);
    const dailyCompressedGb = (dbRawGb * 0.35 + storageGb * 0.72).toFixed(1);
    const retention30dGb = (Number(dailyCompressedGb) * 1.45 + storageGb * 0.85).toFixed(0);
    const backupWindowMin = Math.max(4, Math.round(storageGb * 0.16 + dbRawGb * 0.9));
    const restoreVerifyMin = Math.max(8, Math.round(backupWindowMin * 1.35));

    const stats = [
      { label: 'Сжатый суточный архив', value: `${dailyCompressedGb} ГБ` },
      { label: 'Хранение в S3 (30 дней)', value: `${retention30dGb} ГБ` },
      { label: 'Окно rsync + zstd', value: `${backupWindowMin} мин` },
      { label: 'Тест восстановления (staging)', value: `${restoreVerifyMin} мин` },
    ];

    backupCalcOutput.innerHTML = '';
    stats.forEach((stat) => {
      const card = document.createElement('div');
      card.className = 'calc-stat';

      const lbl = document.createElement('div');
      lbl.className = 'calc-stat-label';
      lbl.textContent = stat.label;

      const val = document.createElement('div');
      val.className = 'calc-stat-value mono-num';
      val.textContent = stat.value;

      card.appendChild(lbl);
      card.appendChild(val);
      backupCalcOutput.appendChild(card);
    });
  }

  if (studentsRange && storageRange) {
    studentsRange.addEventListener('input', updateBackupCalc);
    storageRange.addEventListener('input', updateBackupCalc);
    updateBackupCalc();
  }

  // 5. Copy CLI Script & Toast
  const copyScriptBtn = document.getElementById('copyScriptBtn');
  const copyToast = document.getElementById('copyToast');
  let toastTimer = null;

  function showCopyToast() {
    if (!copyToast) return;
    copyToast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      copyToast.hidden = true;
    }, 2200);
  }

  async function copyCliText(text) {
    if (!text) return;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        showCopyToast();
        return;
      }
    } catch (_err) {
      // Fallback below
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showCopyToast();
    } catch (_err) {
      // Ignore if copy is blocked
    } finally {
      document.body.removeChild(ta);
    }
  }

  if (copyScriptBtn && cliPreviewBoxEl) {
    copyScriptBtn.addEventListener('click', () => {
      copyCliText(cliPreviewBoxEl.textContent || '');
    });
  }

  // 6. Migration Request Modal
  const openRunbookModalBtn = document.getElementById('openRunbookModalBtn');
  const requestModal = document.getElementById('requestModal');
  const closeReqModalBtn = document.getElementById('closeReqModalBtn');
  const migrationRequestForm = document.getElementById('migrationRequestForm');
  const reqContact = document.getElementById('reqContact');
  const reqDbEngine = document.getElementById('reqDbEngine');
  const reqDataSize = document.getElementById('reqDataSize');
  const reqWindow = document.getElementById('reqWindow');
  const reqErrorBox = document.getElementById('reqErrorBox');
  const reqSuccessBox = document.getElementById('reqSuccessBox');
  const reqResetBtn = document.getElementById('reqResetBtn');

  function openModal() {
    if (!requestModal) return;
    requestModal.hidden = false;
  }

  function closeModal() {
    if (!requestModal) return;
    requestModal.hidden = true;
  }

  if (openRunbookModalBtn) {
    openRunbookModalBtn.addEventListener('click', openModal);
  }

  if (closeReqModalBtn) {
    closeReqModalBtn.addEventListener('click', closeModal);
  }

  if (requestModal) {
    requestModal.addEventListener('click', (event) => {
      if (event.target === requestModal) {
        closeModal();
      }
    });
  }

  if (migrationRequestForm) {
    migrationRequestForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const contactVal = reqContact ? reqContact.value.trim() : '';

      if (contactVal.length < 4) {
        if (reqErrorBox) {
          reqErrorBox.textContent = 'Укажите контакт для связи (минимум 4 символа)';
          reqErrorBox.hidden = false;
        }
        if (reqSuccessBox) reqSuccessBox.hidden = true;
        return;
      }

      if (reqErrorBox) reqErrorBox.hidden = true;
      const dbLabel = reqDbEngine ? reqDbEngine.value : 'MariaDB 10.11';
      const dataLabel = reqDataSize ? reqDataSize.value : 'до 50 ГБ';
      const windowLabel = reqWindow ? reqWindow.value : 'Ночное окно (01:00-04:00 МСК)';

      if (reqSuccessBox) {
        reqSuccessBox.textContent = `Заявка зафиксирована для ${contactVal}: СУБД ${dbLabel}, объем moodledata ${dataLabel}, окно ${windowLabel}`;
        reqSuccessBox.hidden = false;
      }
    });
  }

  if (reqResetBtn && migrationRequestForm) {
    reqResetBtn.addEventListener('click', () => {
      migrationRequestForm.reset();
      if (reqErrorBox) reqErrorBox.hidden = true;
      if (reqSuccessBox) reqSuccessBox.hidden = true;
    });
  }
});
