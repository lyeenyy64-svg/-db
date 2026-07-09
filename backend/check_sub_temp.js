const Database = require("better-sqlite3");
const path = require("path");
const DB_PATH = path.join(__dirname, "..", "db", "debtflow.db");
const db = new Database(DB_PATH);
const rows = db.prepare(`
  SELECT DISTINCT d.id, d.name, d.loan_date, d.subrogation_month
  FROM file_index fi
  JOIN debtors d ON (
    fi.parsed_person_name LIKE '%' || SUBSTR(d.name,1,3) || '%'
    OR fi.filename LIKE '%' || SUBSTR(d.name,1,3) || '%'
  )
  WHERE d.loan_date IS NOT NULL
    AND (LOWER(fi.filename) LIKE '%대위변제증명서%' OR LOWER(fi.doc_type) LIKE '%대위변제증명서%')
    AND LOWER(fi.ext) = 'pdf'
  ORDER BY d.name
`).all();
console.log(JSON.stringify(rows));
db.close();
