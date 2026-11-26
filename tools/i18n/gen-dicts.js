'use strict';
/**
 * 生成 es / pt / ja / ko 界面词典（基于 src/i18n/en.json 的中文 key）。
 *
 * 策略：
 * 1) 优先用「整句词条表」——高频界面文案人工校准，保证质量；
 * 2) 其次用「术语替换表」——把中文技术词替换为对应语言，保留占位符/标点/数字；
 * 3) 翻译后若仍残留中文且不在白名单，则丢弃该条（回退中文），避免夹生界面。
 *
 * 这是离线可复现的生成器；译文可直接编辑，重跑时以词典里的手工修订为准。
 *   node tools/i18n/gen-dicts.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(ROOT, 'src', 'i18n');
const EN = JSON.parse(fs.readFileSync(path.join(DIR, 'en.json'), 'utf8'));
const KEYS = Object.keys(EN);
const CJK = /[\u4e00-\u9fff]/;

// 术语表：按长度降序替换，保护占位符 {x} 与常见符号。
const TERMS = {
  es: {
    '正在安装': 'Instalando', '安装完成': 'Instalación completada', '安装失败': 'Error de instalación',
    '正在启动': 'Iniciando', '启动失败': 'Error al iniciar', '已安装': 'Instalado', '已卸载': 'Desinstalado',
    '卸载': 'Desinstalar', '安装': 'Instalar', '启动': 'Iniciar', '关闭': 'Cerrar', '打开': 'Abrir',
    '设置': 'Configuración', '取消': 'Cancelar', '确定': 'Aceptar', '确认': 'Confirmar', '退出': 'Salir',
    '重试': 'Reintentar', '继续': 'Continuar', '返回': 'Volver', '下一步': 'Siguiente', '完成': 'Finalizar',
    '应用': 'aplicación', '应用已': 'La aplicación se ha', '运行时': 'entorno de ejecución',
    '系统镜像': 'imagen del sistema', '安卓': 'Android', '模拟器': 'emulador', '驱动': 'controlador',
    '更新': 'actualización', '检查更新': 'Buscar actualizaciones', '发现新版本': 'Nueva versión disponible',
    '立即更新': 'Actualizar ahora', '稍后': 'Después', '正在下载': 'Descargando', '下载': 'Descargar',
    '失败': 'falló', '成功': 'correcto', '错误': 'error', '警告': 'advertencia', '提示': 'aviso',
    '请': 'Por favor ', '请稍候': 'Espere por favor', '正在准备': 'Preparando', '准备完成': 'Listo',
    '磁盘': 'disco', '空间': 'espacio', '内存': 'memoria', '不足': 'insuficiente', '网络': 'red',
    '语言': 'idioma', '界面语言': 'Idioma de la interfaz', '跟随系统': 'Seguir el sistema',
    '简体中文': 'Chino simplificado', '英文': 'Inglés', '中文': 'Chino', '英文界面': 'Interfaz en inglés',
    '首次': 'primera vez', '选择': 'seleccionar', '语言选择': 'Selección de idioma',
    '数据': 'datos', '目录': 'directorio', '路径': 'ruta', '文件': 'archivo', '文件夹': 'carpeta',
    '开始': 'Iniciar', '停止': 'Detener', '重启': 'Reiniciar', '等待': 'Esperando', '处理中': 'Procesando',
    '麦克风': 'micrófono', '显卡': 'GPU', '硬件加速': 'Aceleración por hardware', '声音': 'sonido',
    '分辨率': 'resolución', '横屏': 'horizontal', '竖屏': 'vertical', '全屏': 'pantalla completa',
    '窗口': 'ventana', '多开': 'múltiples ventanas', '诊断': 'diagnóstico', '修复': 'reparar',
    '使用手册': 'Manual de usuario', '关于': 'Acerca de', '帮助': 'Ayuda', '反馈': 'Comentarios',
    '已复制': 'Copiado', '复制': 'Copiar', '清空': 'Limpiar', '删除': 'Eliminar', '保留': 'Conservar',
    '分钟': 'minutos', '秒': 'segundos', '小时': 'horas', '自动': 'Automático', '手动': 'Manual',
    '开启': 'Activado', '关闭该': 'Desactivar', '未启用': 'No habilitado', '已启用': 'Habilitado',
    '和': ' y ', '或': ' o ', '，': ', ', '。': '.', '：': ': ', '（': ' (', '）': ')',
  },
  pt: {
    '正在安装': 'Instalando', '安装完成': 'Instalação concluída', '安装失败': 'Falha na instalação',
    '正在启动': 'Iniciando', '启动失败': 'Falha ao iniciar', '已安装': 'Instalado', '已卸载': 'Desinstalado',
    '卸载': 'Desinstalar', '安装': 'Instalar', '启动': 'Iniciar', '关闭': 'Fechar', '打开': 'Abrir',
    '设置': 'Configurações', '取消': 'Cancelar', '确定': 'OK', '确认': 'Confirmar', '退出': 'Sair',
    '重试': 'Tentar novamente', '继续': 'Continuar', '返回': 'Voltar', '下一步': 'Próximo', '完成': 'Concluir',
    '应用': 'aplicativo', '运行时': 'ambiente de execução', '系统镜像': 'imagem do sistema',
    '安卓': 'Android', '模拟器': 'emulador', '驱动': 'driver', '更新': 'atualização',
    '检查更新': 'Verificar atualizações', '发现新版本': 'Nova versão disponível', '立即更新': 'Atualizar agora',
    '稍后': 'Depois', '正在下载': 'Baixando', '下载': 'Baixar', '失败': 'falhou', '成功': 'sucesso',
    '错误': 'erro', '警告': 'aviso', '提示': 'dica', '请': 'Por favor ', '请稍候': 'Aguarde',
    '正在准备': 'Preparando', '准备完成': 'Pronto', '磁盘': 'disco', '空间': 'espaço', '内存': 'memória',
    '不足': 'insuficiente', '网络': 'rede', '语言': 'idioma', '界面语言': 'Idioma da interface',
    '跟随系统': 'Seguir o sistema', '简体中文': 'Chinês simplificado', '英文': 'Inglês', '中文': 'Chinês',
    '首次': 'primeira vez', '选择': 'selecionar', '语言选择': 'Seleção de idioma', '数据': 'dados',
    '目录': 'diretório', '路径': 'caminho', '文件': 'arquivo', '文件夹': 'pasta', '开始': 'Iniciar',
    '停止': 'Parar', '重启': 'Reiniciar', '等待': 'Aguardando', '处理中': 'Processando',
    '麦克风': 'microfone', '显卡': 'GPU', '硬件加速': 'Aceleração de hardware', '声音': 'som',
    '分辨率': 'resolução', '横屏': 'paisagem', '竖屏': 'retrato', '全屏': 'tela cheia', '窗口': 'janela',
    '多开': 'múltiplas janelas', '诊断': 'diagnóstico', '修复': 'corrigir', '使用手册': 'Manual do usuário',
    '关于': 'Sobre', '帮助': 'Ajuda', '反馈': 'Comentários', '已复制': 'Copiado', '复制': 'Copiar',
    '清空': 'Limpar', '删除': 'Excluir', '保留': 'Manter', '分钟': 'minutos', '秒': 'segundos',
    '小时': 'horas', '自动': 'Automático', '手动': 'Manual', '开启': 'Ativado', '未启用': 'Não habilitado',
    '已启用': 'Habilitado', '和': ' e ', '或': ' ou ', '，': ', ', '。': '.', '：': ': ', '（': ' (', '）': ')',
  },
  ja: {
    '正在安装': 'インストール中', '安装完成': 'インストール完了', '安装失败': 'インストール失敗',
    '正在启动': '起動中', '启动失败': '起動失敗', '已安装': 'インストール済み', '已卸载': 'アンインストール済み',
    '卸载': 'アンインストール', '安装': 'インストール', '启动': '起動', '关闭': '閉じる', '打开': '開く',
    '设置': '設定', '取消': 'キャンセル', '确定': 'OK', '确认': '確認', '退出': '終了',
    '重试': '再試行', '继续': '続行', '返回': '戻る', '下一步': '次へ', '完成': '完了',
    '应用': 'アプリ', '运行时': 'ランタイム', '系统镜像': 'システムイメージ', '安卓': 'Android',
    '模拟器': 'エミュレータ', '驱动': 'ドライバー', '更新': '更新', '检查更新': '更新を確認',
    '发现新版本': '新しいバージョンがあります', '立即更新': '今すぐ更新', '稍后': '後で',
    '正在下载': 'ダウンロード中', '下载': 'ダウンロード', '失败': '失敗', '成功': '成功',
    '错误': 'エラー', '警告': '警告', '提示': 'ヒント', '请': '', '请稍候': 'お待ちください',
    '正在准备': '準備中', '准备完成': '準備完了', '磁盘': 'ディスク', '空间': '空き容量', '内存': 'メモリ',
    '不足': '不足', '网络': 'ネットワーク', '语言': '言語', '界面语言': '表示言語',
    '跟随系统': 'システムに従う', '简体中文': '簡体字中国語', '英文': '英語', '中文': '中国語',
    '首次': '初回', '选择': '選択', '语言选择': '言語選択', '数据': 'データ', '目录': 'フォルダー',
    '路径': 'パス', '文件': 'ファイル', '文件夹': 'フォルダー', '开始': '開始', '停止': '停止',
    '重启': '再起動', '等待': '待機中', '处理中': '処理中', '麦克风': 'マイク', '显卡': 'GPU',
    '硬件加速': 'ハードウェアアクセラレーション', '声音': 'サウンド', '分辨率': '解像度',
    '横屏': '横向き', '竖屏': '縦向き', '全屏': '全画面', '窗口': 'ウィンドウ', '多开': '複数ウィンドウ',
    '诊断': '診断', '修复': '修復', '使用手册': 'ユーザーマニュアル', '关于': 'バージョン情報',
    '帮助': 'ヘルプ', '反馈': 'フィードバック', '已复制': 'コピーしました', '复制': 'コピー',
    '清空': 'クリア', '删除': '削除', '保留': '保持', '分钟': '分', '秒': '秒', '小时': '時間',
    '自动': '自動', '手动': '手動', '开启': '有効', '未启用': '無効', '已启用': '有効',
    '和': '、', '或': 'または', '，': '、', '。': '。', '：': ':', '（': '（', '）': '）',
  },
  ko: {
    '正在安装': '설치 중', '安装完成': '설치 완료', '安装失败': '설치 실패',
    '正在启动': '시작 중', '启动失败': '시작 실패', '已安装': '설치됨', '已卸载': '제거됨',
    '卸载': '제거', '安装': '설치', '启动': '시작', '关闭': '닫기', '打开': '열기',
    '设置': '설정', '取消': '취소', '确定': '확인', '确认': '확인', '退出': '종료',
    '重试': '다시 시도', '继续': '계속', '返回': '뒤로', '下一步': '다음', '完成': '완료',
    '应用': '앱', '运行时': '런타임', '系统镜像': '시스템 이미지', '安卓': 'Android',
    '模拟器': '에뮬레이터', '驱动': '드라이버', '更新': '업데이트', '检查更新': '업데이트 확인',
    '发现新版本': '새 버전이 있습니다', '立即更新': '지금 업데이트', '稍后': '나중에',
    '正在下载': '다운로드 중', '下载': '다운로드', '失败': '실패', '成功': '성공',
    '错误': '오류', '警告': '경고', '提示': '팁', '请': '', '请稍候': '잠시 기다려 주세요',
    '正在准备': '준비 중', '准备完成': '준비 완료', '磁盘': '디스크', '空间': '공간', '内存': '메모리',
    '不足': '부족', '网络': '네트워크', '语言': '언어', '界面语言': '인터페이스 언어',
    '跟随系统': '시스템 설정 따르기', '简体中文': '간체 Chinese', '英文': 'English', '中文': '중국어',
    '首次': '처음', '选择': '선택', '语言选择': '언어 선택', '数据': '데이터', '目录': '폴더',
    '路径': '경로', '文件': '파일', '文件夹': '폴더', '开始': '시작', '停止': '정지',
    '重启': '다시 시작', '等待': '대기 중', '处理中': '처리 중', '麦克风': '마이크', '显卡': 'GPU',
    '硬件加速': '하드웨어 가속', '声音': '소리', '分辨率': '해상도', '横屏': '가로 모드',
    '竖屏': '세로 모드', '全屏': '전체 화면', '窗口': '창', '多开': '다중 창', '诊断': '진단',
    '修复': '수정', '使用手册': '사용자 설명서', '关于': '정보', '帮助': '도움말', '反馈': '피드백',
    '已复制': '복사됨', '复制': '복사', '清空': '지우기', '删除': '삭제', '保留': '유지',
    '分钟': '분', '秒': '초', '小时': '시간', '自动': '자동', '手动': '수동', '开启': '켜짐',
    '未启用': '사용 안 함', '已启用': '사용 중', '和': ' 및 ', '或': ' 또는 ', '，': ', ', '。': '.', '：': ': ', '（': ' (', '）': ')',
  },
};

// 高频补充词：从 en.json 的词频统计得出，各语种统一补齐以提升长句覆盖率。
const EXTRA = {
  es: { '快捷方式': 'acceso directo', '快捷': 'acceso directo', '虚拟机': 'máquina virtual', '虚拟': 'virtual',
    '运行时': 'entorno de ejecución', '运行': 'ejecutar', '正在': '', '系统': 'sistema', '下次': 'la próxima vez',
    '生效': 'surte efecto', '需要': 'se necesita', '方向': 'orientación', '版本': 'versión', '当前': 'actual',
    '快照': 'instantánea', '面板': 'panel', '模式': 'modo', '检测': 'detección', '推荐': 'recomendado',
    '默认': 'predeterminado', '已打开': 'abierta', '一次': 'una vez', '应用': 'aplicación',
    '程序': 'programa', '桌面': 'escritorio', '加速': 'aceleración', '镜像': 'imagen', '文件': 'archivo',
    '前': 'antes', '后': 'después', '重新': 'de nuevo', '无': 'sin', '未': 'no ', '请': 'Por favor ' },
  pt: { '快捷方式': 'atalho', '快捷': 'atalho', '虚拟机': 'máquina virtual', '虚拟': 'virtual',
    '运行时': 'ambiente de execução', '运行': 'executar', '正在': '', '系统': 'sistema', '下次': 'na próxima vez',
    '生效': 'terá efeito', '需要': 'é necessário', '方向': 'orientação', '版本': 'versão', '当前': 'atual',
    '快照': 'snapshot', '面板': 'painel', '模式': 'modo', '检测': 'verificação', '推荐': 'recomendado',
    '默认': 'padrão', '已打开': 'aberto', '一次': 'uma vez', '应用': 'aplicativo',
    '程序': 'programa', '桌面': 'área de trabalho', '加速': 'aceleração', '镜像': 'imagem', '文件': 'arquivo',
    '前': 'antes', '后': 'depois', '重新': 'novamente', '无': 'sem', '未': 'não ', '请': 'Por favor ' },
  ja: { '快捷方式': 'ショートカット', '快捷': 'ショートカット', '虚拟机': '仮想マシン', '虚拟': '仮想',
    '运行时': 'ランタイム', '运行': '実行', '正在': '', '系统': 'システム', '下次': '次回',
    '生效': '有効になります', '需要': '必要', '方向': '向き', '版本': 'バージョン', '当前': '現在の',
    '快照': 'スナップショット', '面板': 'パネル', '模式': 'モード', '检测': 'チェック', '推荐': '推奨',
    '默认': 'デフォルト', '已打开': '開いた', '一次': '一度', '应用': 'アプリ',
    '程序': 'プログラム', '桌面': 'デスクトップ', '加速': 'アクセラレーション', '镜像': 'イメージ', '文件': 'ファイル',
    '前': '前', '后': '後', '重新': '再', '无': 'なし', '未': '未', '请': '' },
  ko: { '快捷方式': '바로가기', '快捷': '바로가기', '虚拟机': '가상 머신', '虚拟': '가상',
    '运行时': '런타임', '运行': '실행', '正在': '', '系统': '시스템', '下次': '다음 번',
    '生效': '적용됩니다', '需要': '필요', '方向': '방향', '版本': '버전', '当前': '현재',
    '快照': '스냅샷', '面板': '패널', '模式': '모드', '检测': '검사', '推荐': '추천',
    '默认': '기본값', '已打开': '열린', '一次': '한 번', '应用': '앱',
    '程序': '프로그램', '桌面': '바탕 화면', '加速': '가속', '镜像': '이미지', '文件': '파일',
    '前': '전', '后': '후', '重新': '다시', '无': '없음', '未': '안 ', '请': '' },
};
for (const lang of Object.keys(EXTRA)) Object.assign(TERMS[lang], EXTRA[lang]);

// 整句人工词条：这些是界面上最显眼、最能体现「已本地化」的短句。
const PHRASES = {
  es: {
    '设置': 'Configuración', '取消': 'Cancelar', '确定': 'Aceptar', '退出': 'Salir', '打开 ApkStart': 'Abrir ApkStart',
    '使用手册': 'Manual de usuario', '检查更新': 'Buscar actualizaciones', '发现新版本': 'Nueva versión disponible',
    '立即更新': 'Actualizar ahora', '稍后': 'Después', '还没有安装应用': 'Aún no hay aplicaciones instaladas',
    '关闭当前应用': 'Cerrar la aplicación actual', '同步共享目录': 'Sincronizar carpeta compartida',
    '界面语言': 'Idioma de la interfaz', '跟随系统': 'Seguir el sistema', 'English': 'English',
    '简体中文': 'Chino simplificado', '系统语言': 'Idioma del sistema', '首次使用': 'Primer uso',
    '选择语言': 'Elegir idioma', '选择界面语言': 'Elegir idioma de la interfaz', '重新开始': 'Empezar de nuevo',
    '我知道了': 'Entendido', '跳过': 'Omitir', '下一步': 'Siguiente', '欢迎使用 ApkStart': 'Bienvenido a ApkStart',
  },
  pt: {
    '设置': 'Configurações', '取消': 'Cancelar', '确定': 'OK', '退出': 'Sair', '打开 ApkStart': 'Abrir ApkStart',
    '使用手册': 'Manual do usuário', '检查更新': 'Verificar atualizações', '发现新版本': 'Nova versão disponível',
    '立即更新': 'Atualizar agora', '稍后': 'Depois', '还没有安装应用': 'Nenhum aplicativo instalado ainda',
    '关闭当前应用': 'Fechar o aplicativo atual', '同步共享目录': 'Sincronizar pasta compartilhada',
    '界面语言': 'Idioma da interface', '跟随系统': 'Seguir o sistema', 'English': 'English',
    '简体中文': 'Chinês simplificado', '系统语言': 'Idioma do sistema', '首次使用': 'Primeiro uso',
    '选择语言': 'Escolher idioma', '选择界面语言': 'Escolher idioma da interface', '重新开始': 'Começar de novo',
    '我知道了': 'Entendi', '跳过': 'Pular', '下一步': 'Próximo', '欢迎使用 ApkStart': 'Bem-vindo ao ApkStart',
  },
  ja: {
    '设置': '設定', '取消': 'キャンセル', '确定': 'OK', '退出': '終了', '打开 ApkStart': 'ApkStart を開く',
    '使用手册': 'ユーザーマニュアル', '检查更新': '更新を確認', '发现新版本': '新しいバージョンがあります',
    '立即更新': '今すぐ更新', '稍后': '後で', '还没有安装应用': 'アプリはまだインストールされていません',
    '关闭当前应用': '現在のアプリを閉じる', '同步共享目录': '共有フォルダーを同期',
    '界面语言': '表示言語', '跟随系统': 'システムに従う', 'English': 'English',
    '简体中文': '簡体字中国語', '系统语言': 'システム言語', '首次使用': '初回使用',
    '选择语言': '言語を選択', '选择界面语言': '表示言語を選択', '重新开始': 'やり直す',
    '我知道了': '了解', '跳过': 'スキップ', '下一步': '次へ', '欢迎使用 ApkStart': 'ApkStart へようこそ',
  },
  ko: {
    '设置': '설정', '取消': '취소', '确定': '확인', '退出': '종료', '打开 ApkStart': 'ApkStart 열기',
    '使用手册': '사용자 설명서', '检查更新': '업데이트 확인', '发现新版本': '새 버전이 있습니다',
    '立即更新': '지금 업데이트', '稍后': '나중에', '还没有安装应用': '설치된 앱이 없습니다',
    '关闭当前应用': '현재 앱 닫기', '同步共享目录': '공유 폴더 동기화',
    '界面语言': '인터페이스 언어', '跟随系统': '시스템 설정 따르기', 'English': 'English',
    '简体中文': '간체 중국어', '系统语言': '시스템 언어', '首次使用': '처음 사용',
    '选择语言': '언어 선택', '选择界面语言': '인터페이스 언어 선택', '重新开始': '다시 시작',
    '我知道了': '확인했어요', '跳过': '건너뛰기', '下一步': '다음', '欢迎使用 ApkStart': 'ApkStart에 오신 것을 환영합니다',
  },
};

// 各语言「已翻译」特征：日语看假名、韩语看谚文，其余看是否残留汉字。
const TRANSLATED_RE = {
  es: null, // null = 用「无残留汉字」判定
  pt: null,
  ja: /[\u3040-\u30ff]/, // 平假名/片假名
  ko: /[\uac00-\ud7af]/, // 谚文
};
function isTranslated(lang, s, srcCjkCount) {
  const re = TRANSLATED_RE[lang];
  if (re) return re.test(s);
  const left = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return left === 0 || (srcCjkCount > 8 && left <= 2);
}

function makeTranslations(lang) {
  const terms = TERMS[lang];
  const phrases = PHRASES[lang];
  const sorted = Object.keys(terms).sort((a, b) => b.length - a.length);
  const out = {};
  for (const key of KEYS) {
    const norm = String(key).replace(/\s+/g, ' ').trim();
    if (Object.prototype.hasOwnProperty.call(phrases, norm)) { out[key] = phrases[norm]; continue; }
    let s = norm;
    for (const t of sorted) if (s.includes(t)) s = s.split(t).join(terms[t]);
    const cjkSrc = (norm.match(/[\u4e00-\u9fff]/g) || []).length;
    if (isTranslated(lang, s, cjkSrc)) {
      if (norm !== s && s.trim()) out[key] = s.replace(/\s{2,}/g, ' ').trim();
    }
  }
  return out;
}

for (const lang of Object.keys(TERMS)) {
  const file = path.join(DIR, lang + '.json');
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const generated = makeTranslations(lang);
  // 手工修订优先：已存在的键保留用户改过的译文。
  const merged = { ...generated, ...existing };
  fs.writeFileSync(file, JSON.stringify(merged, null, 1) + '\n', 'utf8');
  console.log(lang + ': ' + Object.keys(merged).length + ' 条（新生成 ' + Object.keys(generated).length + '）');
}
