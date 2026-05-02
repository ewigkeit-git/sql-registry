export type DocsLang = "en" | "ja" | "ko" | "zh-CN" | "zh-TW" | "es" | "fr" | "de" | "ru";

export type DocsLabelKey =
  | "appendQuery"
  | "builder"
  | "dynamic"
  | "explain"
  | "files"
  | "home"
  | "logicalName"
  | "noParams"
  | "none"
  | "overview"
  | "physicalName"
  | "params"
  | "source"
  | "sql"
  | "sqlIds"
  | "static"
  | "tags"
  | "type"
  | "validationErrors";

type DocsLabels = Record<DocsLabelKey, string>;

export const DOC_I18N_RESOURCES: Record<DocsLang, { translation: DocsLabels }> = {
  en: {
    translation: {
      appendQuery: "appendQuery References",
      builder: "Builder",
      dynamic: "dynamic",
      explain: "EXPLAIN",
      files: "Files",
      home: "Home",
      logicalName: "Logical Name",
      noParams: "No params.",
      none: "None",
      overview: "Overview",
      physicalName: "Physical Name",
      params: "Params",
      source: "Source",
      sql: "SQL",
      sqlIds: "SQL IDs",
      static: "static",
      tags: "Tags",
      type: "Type",
      validationErrors: "Validation Errors"
    }
  },
  ja: {
    translation: {
      appendQuery: "appendQuery 参照",
      builder: "Builder",
      dynamic: "動的",
      explain: "EXPLAIN",
      files: "ファイル",
      home: "ホーム",
      logicalName: "論理名",
      noParams: "パラメータなし。",
      none: "なし",
      overview: "概要",
      physicalName: "物理名",
      params: "パラメータ",
      source: "定義元",
      sql: "SQL",
      sqlIds: "SQL ID",
      static: "静的",
      tags: "タグ",
      type: "型",
      validationErrors: "検証エラー"
    }
  },
  ko: {
    translation: {
      appendQuery: "appendQuery 참조",
      builder: "Builder",
      dynamic: "동적",
      explain: "EXPLAIN",
      files: "파일",
      home: "홈",
      logicalName: "논리명",
      noParams: "파라미터 없음.",
      none: "없음",
      overview: "개요",
      physicalName: "물리명",
      params: "파라미터",
      source: "정의 위치",
      sql: "SQL",
      sqlIds: "SQL ID",
      static: "정적",
      tags: "태그",
      type: "유형",
      validationErrors: "검증 오류"
    }
  },
  "zh-CN": {
    translation: {
      appendQuery: "appendQuery 引用",
      builder: "Builder",
      dynamic: "动态",
      explain: "EXPLAIN",
      files: "文件",
      home: "首页",
      logicalName: "逻辑名",
      noParams: "无参数。",
      none: "无",
      overview: "概览",
      physicalName: "物理名",
      params: "参数",
      source: "定义来源",
      sql: "SQL",
      sqlIds: "SQL ID",
      static: "静态",
      tags: "标签",
      type: "类型",
      validationErrors: "验证错误"
    }
  },
  "zh-TW": {
    translation: {
      appendQuery: "appendQuery 參照",
      builder: "Builder",
      dynamic: "動態",
      explain: "EXPLAIN",
      files: "檔案",
      home: "首頁",
      logicalName: "邏輯名稱",
      noParams: "無參數。",
      none: "無",
      overview: "概覽",
      physicalName: "實體名稱",
      params: "參數",
      source: "定義來源",
      sql: "SQL",
      sqlIds: "SQL ID",
      static: "靜態",
      tags: "標籤",
      type: "類型",
      validationErrors: "驗證錯誤"
    }
  },
  es: {
    translation: {
      appendQuery: "Referencias appendQuery",
      builder: "Builder",
      dynamic: "dinámico",
      explain: "EXPLAIN",
      files: "Archivos",
      home: "Inicio",
      logicalName: "Nombre lógico",
      noParams: "Sin parámetros.",
      none: "Ninguno",
      overview: "Resumen",
      physicalName: "Nombre físico",
      params: "Parámetros",
      source: "Origen",
      sql: "SQL",
      sqlIds: "SQL IDs",
      static: "estático",
      tags: "Etiquetas",
      type: "Tipo",
      validationErrors: "Errores de validación"
    }
  },
  fr: {
    translation: {
      appendQuery: "Références appendQuery",
      builder: "Builder",
      dynamic: "dynamique",
      explain: "EXPLAIN",
      files: "Fichiers",
      home: "Accueil",
      logicalName: "Nom logique",
      noParams: "Aucun paramètre.",
      none: "Aucun",
      overview: "Vue d'ensemble",
      physicalName: "Nom physique",
      params: "Paramètres",
      source: "Source",
      sql: "SQL",
      sqlIds: "IDs SQL",
      static: "statique",
      tags: "Tags",
      type: "Type",
      validationErrors: "Erreurs de validation"
    }
  },
  de: {
    translation: {
      appendQuery: "appendQuery-Referenzen",
      builder: "Builder",
      dynamic: "dynamisch",
      explain: "EXPLAIN",
      files: "Dateien",
      home: "Start",
      logicalName: "Logischer Name",
      noParams: "Keine Parameter.",
      none: "Keine",
      overview: "Übersicht",
      physicalName: "Physischer Name",
      params: "Parameter",
      source: "Quelle",
      sql: "SQL",
      sqlIds: "SQL-IDs",
      static: "statisch",
      tags: "Tags",
      type: "Typ",
      validationErrors: "Validierungsfehler"
    }
  },
  ru: {
    translation: {
      appendQuery: "Ссылки appendQuery",
      builder: "Builder",
      dynamic: "динамический",
      explain: "EXPLAIN",
      files: "Файлы",
      home: "Главная",
      logicalName: "Логическое имя",
      noParams: "Нет параметров.",
      none: "Нет",
      overview: "Обзор",
      physicalName: "Физическое имя",
      params: "Параметры",
      source: "Источник",
      sql: "SQL",
      sqlIds: "SQL ID",
      static: "статический",
      tags: "Теги",
      type: "Тип",
      validationErrors: "Ошибки проверки"
    }
  }
};

export function normalizeDocsLang(input?: string): DocsLang {
  if (!input) return "en";
  const value = String(input);
  return value in DOC_I18N_RESOURCES ? value as DocsLang : "en";
}

export function createDocsTranslator(input?: string) {
  const lang = normalizeDocsLang(input);
  const labels = DOC_I18N_RESOURCES[lang].translation;
  const fallback = DOC_I18N_RESOURCES.en.translation;

  return {
    lang,
    t: (key: DocsLabelKey) => labels[key] || fallback[key]
  };
}
