require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
const bank = [
["QA","QUANT","ARITHMETIC","A shirt costs ₹800 after a 20% discount. What was the marked price?",["₹960","₹1000","₹1040","₹900"],1],
["QA","QUANT","ARITHMETIC","An article bought for ₹500 is sold at 12% profit. Selling price?",["₹550","₹560","₹580","₹600"],1],
["QA","QUANT","ARITHMETIC","A finishes a job in 12 days, B in 6. Together they take?",["3 days","4 days","5 days","9 days"],1],
["QA","QUANT","ARITHMETIC","A train covers 180 km in 3 hours. Its speed in m/s is about?",["16.7","18","20","15"],0],
["QA","QUANT","ARITHMETIC","Simple interest on ₹2000 at 5% for 3 years is?",["₹250","₹300","₹350","₹400"],1],
["QA","QUANT","ARITHMETIC","Divide ₹360 in the ratio 2:3:4. The largest share is?",["₹120","₹140","₹160","₹180"],2],
["QA","QUANT","ARITHMETIC","The average of 5 numbers is 24. Their sum is?",["100","110","120","130"],2],
["EM","EAMCET","MATHEMATICS","If x² − 5x + 6 = 0, the sum of its roots is?",["−5","5","6","−6"],1],
["EM","EAMCET","MATHEMATICS","d/dx (sin x · x) at x = 0 equals?",["0","1","−1","2"],0],
["EM","EAMCET","MATHEMATICS","The value of log₂ 32 is?",["4","5","6","3"],1],
["EP","EAMCET","PHYSICS","The SI unit of electric potential is?",["Ampere","Ohm","Volt","Tesla"],2],
["EP","EAMCET","PHYSICS","A body of 2 kg moving at 3 m/s has kinetic energy?",["3 J","6 J","9 J","18 J"],2],
["EC","EAMCET","CHEMISTRY","The atomic number of carbon is?",["4","6","8","12"],1],
["EC","EAMCET","CHEMISTRY","pH of a neutral solution at 25°C is?",["0","1","7","14"],2]
];
(async () => {
  try {
    const n = await pool.query("SELECT COUNT(*)::int AS n FROM questions");
    if (n.rows[0].n) { console.log("Question table already contains rows; seed skipped."); return; }
    for (const [key,category,subject,text,opts,correct] of bank) {
      await pool.query(`INSERT INTO questions(question_text,category,subject,difficulty,option_a,option_b,option_c,option_d,correct_option,marks,is_active)
        VALUES($1,$2,$3,'MEDIUM',$4,$5,$6,$7,$8,1,TRUE)`,
        [text,category,subject,...opts,correct]);
    }
    console.log(`Seeded ${bank.length} demonstration questions.`);
    console.log("Note: add enough questions in Admin Question Bank for the configured exam size.");
  } finally { await pool.end(); }
})().catch(e => { console.error(e); process.exit(1); });
