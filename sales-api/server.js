/* ============================================================================
   HUFT CRM Strategy — sales-api
   Node/Express -> MySQL (Sales_Data). Exposes Supabase-style RPC endpoints the
   single-file frontend calls when USE_MOCK=false.

   Endpoints:
     GET /health
     GET /rest/v1/rpc/strategy_sales_by_product   per strategy-node units+revenue for lm/ly/tq
     GET /rest/v1/rpc/strategy_combo_affinity      2-product co-purchase cohorts (opt-in)

   TWO THINGS TO CONFIRM against your real table (both are single edit-blocks below):
     1) COL  — the actual column names (run: DESCRIBE sales_data;)
     2) NODE_RULES — how raw products roll up into the ~30 strategy nodes
   ============================================================================ */
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");

/* ---- connection (env-driven; defaults match the HUFT IQ sales feed) ---- */
const CFG = {
  host: process.env.DB_HOST || "172.18.11.27",
  user: process.env.DB_USER || "crm_ro",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "Sales_Data",
  table: process.env.DB_TABLE || "sales_data",
  port: Number(process.env.DB_PORT || 3306),
};
const PORT = Number(process.env.PORT || 8787);
const ENABLE_AFFINITY = process.env.ENABLE_AFFINITY === "true";

/* ============================================================================
   1) COLUMN MAP — set these to your real column names, then everything works.
      Values on the right are the logical fields from the CleverTap "Charged"
      payload; the left keys are what the queries use.
   ============================================================================ */
const COL = {
  order_date:   "order_date",    // when the order was placed (DATE/DATETIME)
  order_id:     "event_id",      // event_ID  == order name (basket key for affinity)
  product_name: "product_name",  // Product Name
  brand:        "brand",         // vendor
  category:     "category",      // product.type
  sku:          "cookie_id",     // item.sku
  qty:          "quantity",      // Quantity
  price:        "item_price",    // per-unit price in rupees (already /100 at capture)
  channel:      "channel",       // "Website" etc. Optional; used for D2C share.
};

/* ============================================================================
   2) NODE_RULES — roll raw rows up into the frontend's strategy nodes.
      Matched (in order, first win) against lowercased "name brand category".
      all: every token must be present. none: none may be present.
      Node ids MUST match the CATALOG ids in index.html.
   ============================================================================ */
const NODE_RULES = [
  { id:"swf-broth",        all:["swf","broth"] },
  { id:"swf-food",         all:["swf"], none:["broth"] },
  { id:"sara-probiotic",   all:["probiotic"] },
  { id:"sara-boosters",    all:["booster"] },
  { id:"sara-gravy",       all:["sara","gravy"] },
  { id:"sara-treats",      all:["sara","treat"] },
  { id:"hearty-gravy",     all:["hearty","gravy"] },
  { id:"hearty-biscuits",  all:["hearty"], any:["biscuit","bisc"] },
  { id:"hearty-dry",       all:["hearty"] },
  { id:"nutriwag-treats",  all:["nutriwag","treat"] },
  { id:"nutriwag-pro",     all:["nutriwag","pro"] },
  { id:"nutriwag-wet",     all:["nutriwag"], any:["wet","gravy"] },
  { id:"nutriwag-dry",     all:["nutriwag"] },
  { id:"yakies",           all:["yaki"] },
  { id:"yumnums",          all:["yum"] },
  { id:"yimt",             all:["yimt"] },
  { id:"chewbarks",        any:["chew bark","chewbark"] },
  { id:"barkery",          all:["barkery"] },
  { id:"meowsi-crunchy",   all:["meowsi","crunch"] },
  { id:"meowsi-soft",      all:["meowsi","soft"] },
  { id:"meowsi-wet",       all:["meowsi"], none:["crunch","soft"] },
  { id:"nutrimeow-wet",    all:["nutrimeow"], any:["wet","gravy"] },
  { id:"nutrimeow-dry",    all:["nutrimeow"] },
  { id:"p3-royalcanin",    any:["royal canin"] },
  { id:"p3-farmina",       any:["farmina","n&d"] },
  { id:"p3-sheba",         all:["sheba"] },
  { id:"p3-drools",        all:["drools"] },
  { id:"life-grooming",    any:["grooming","shampoo","groom"] },
  { id:"life-toys",        any:["toy","toys"] },
  { id:"life-clh",         any:["apparel","clothing","t-shirt","raincoat","sweater"] },
  { id:"life-acc",         any:["collar","leash","harness","bowl","bed"] },
];
function mapNode(name, brand, category){
  const t = `${name||""} ${brand||""} ${category||""}`.toLowerCase();
  const has = w => t.includes(w);
  for (const r of NODE_RULES){
    if (r.all && !r.all.every(has)) continue;
    if (r.none && r.none.some(has)) continue;
    if (r.any && !r.any.some(has)) continue;
    return r.id;
  }
  return null; // unmapped -> ignored (surface later via /health if you want)
}

/* ---- period windows (CURDATE-relative), computed in SQL ---- */
const LM_START = `DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH,'%Y-%m-01')`;
const LM_END   = `DATE_FORMAT(CURDATE(),'%Y-%m-01')`;
const LY_START = `${LM_START} - INTERVAL 1 YEAR`;
const LY_END   = `${LM_END} - INTERVAL 1 YEAR`;
const TQ_START = `DATE_FORMAT(CURDATE(),'%Y-01-01') + INTERVAL (QUARTER(CURDATE())-1)*3 MONTH`;
const TQ_END   = `CURDATE() + INTERVAL 1 DAY`;
const D = c => `\`${c}\``; // backtick a column

const pool = mysql.createPool({ ...CFG, waitForConnections:true, connectionLimit:5, dateStrings:true });

const app = express();
app.use(cors());

app.get("/health", async (req,res)=>{
  try{ const [r]=await pool.query("SELECT 1 AS ok"); res.json({ok:true, db:CFG.database, table:CFG.table, affinity:ENABLE_AFFINITY}); }
  catch(e){ res.status(500).json({ok:false, error:String(e.message||e)}); }
});

/* ---- strategy_sales_by_product ---- */
app.get("/rest/v1/rpc/strategy_sales_by_product", async (req,res)=>{
  try{
    const T=D(CFG.table), dt=D(COL.order_date), nm=D(COL.product_name), br=D(COL.brand), ct=D(COL.category),
          q=D(COL.qty), pr=D(COL.price), ch=COL.channel?D(COL.channel):null;
    const winSum = (a,b,expr)=>`SUM(CASE WHEN ${dt} >= ${a} AND ${dt} < ${b} THEN ${expr} ELSE 0 END)`;
    const rev = `${q}*${pr}`;
    const channelSel = ch ? `, ${winSum(LM_START,LM_END,`CASE WHEN ${ch} IN ('Website','App','D2C') THEN ${rev} ELSE 0 END`)} AS lm_d2c` : "";
    const sql =
      `SELECT ${nm} AS name, ${br} AS brand, ${ct} AS category,
              ${winSum(LM_START,LM_END,q)} AS lm_u, ${winSum(LM_START,LM_END,rev)} AS lm_r,
              ${winSum(LY_START,LY_END,q)} AS ly_u, ${winSum(LY_START,LY_END,rev)} AS ly_r,
              ${winSum(TQ_START,TQ_END,q)} AS tq_u, ${winSum(TQ_START,TQ_END,rev)} AS tq_r
              ${channelSel}
       FROM ${T}
       WHERE ${dt} >= ${LY_START}
       GROUP BY ${nm}, ${br}, ${ct}`;
    const [rows] = await pool.query(sql);
    const acc = {};
    for (const r of rows){
      const id = mapNode(r.name, r.brand, r.category); if(!id) continue;
      const a = acc[id] || (acc[id] = {id, lm:{units:0,rev:0}, ly:{units:0,rev:0}, tq:{units:0,rev:0}, _d2c:0});
      a.lm.units+=+r.lm_u||0; a.lm.rev+=+r.lm_r||0;
      a.ly.units+=+r.ly_u||0; a.ly.rev+=+r.ly_r||0;
      a.tq.units+=+r.tq_u||0; a.tq.rev+=+r.tq_r||0;
      if(ch) a._d2c += +r.lm_d2c||0;
    }
    const out = Object.values(acc).map(a=>{
      const o={id:a.id, lm:a.lm, ly:a.ly, tq:a.tq};
      if(ch && a.lm.rev>0) o.d2cShare = Math.max(0,Math.min(1, a._d2c/a.lm.rev));
      return o;
    });
    res.json(out);
  }catch(e){ console.error(e); res.status(500).json({error:String(e.message||e)}); }
});

/* ---- strategy_combo_affinity (opt-in; heavy self-join — prefer a materialized view in prod) ---- */
app.get("/rest/v1/rpc/strategy_combo_affinity", async (req,res)=>{
  if(!ENABLE_AFFINITY) return res.json([]); // frontend falls back to its mock affinity
  try{
    const T=D(CFG.table), dt=D(COL.order_date), oid=D(COL.order_id), nm=D(COL.product_name), br=D(COL.brand), ct=D(COL.category);
    const [tot] = await pool.query(`SELECT COUNT(DISTINCT ${oid}) t FROM ${T} WHERE ${dt} >= ${TQ_START}`);
    const totalBaskets = +tot[0].t || 1;
    const [freqRows] = await pool.query(
      `SELECT ${nm} AS name, ${br} AS brand, ${ct} AS category, COUNT(DISTINCT ${oid}) AS baskets
       FROM ${T} WHERE ${dt} >= ${TQ_START} GROUP BY ${nm}, ${br}, ${ct}`);
    const nodeFreq={}, meta={};
    for(const r of freqRows){ const id=mapNode(r.name,r.brand,r.category); if(!id)continue;
      nodeFreq[id]=(nodeFreq[id]||0)+(+r.baskets||0); meta[id]=id; }
    const [pairs] = await pool.query(
      `SELECT a.${COL.product_name} AS an, a.${COL.brand} AS ab, a.${COL.category} AS ac,
              b.${COL.product_name} AS bn, b.${COL.brand} AS bb, b.${COL.category} AS bc,
              COUNT(DISTINCT a.${COL.order_id}) AS co
       FROM ${T} a JOIN ${T} b
         ON a.${COL.order_id}=b.${COL.order_id} AND a.${COL.product_name} < b.${COL.product_name}
       WHERE a.${COL.order_date} >= ${TQ_START}
       GROUP BY an,ab,ac,bn,bb,bc HAVING co >= 20 ORDER BY co DESC LIMIT 800`);
    const nodePairs={};
    for(const r of pairs){
      const x=mapNode(r.an,r.ab,r.ac), y=mapNode(r.bn,r.bb,r.bc);
      if(!x||!y||x===y)continue; const key=[x,y].sort().join("|");
      nodePairs[key]=(nodePairs[key]||0)+(+r.co||0);
    }
    const out = Object.entries(nodePairs).map(([key,co])=>{
      const [x,y]=key.split("|"); const fx=nodeFreq[x]||1, fy=nodeFreq[y]||1;
      const lift = (co*totalBaskets)/(fx*fy);
      const push = fx<=fy ? x : y;              // grow the lower-penetration node
      return { items:[x,y], name:`${x} × ${y} buyers`, size:co, lift:+lift.toFixed(1), push,
               why:`Bought together in ${co} baskets this quarter` };
    }).sort((a,b)=>b.size-a.size).slice(0,8);
    res.json(out);
  }catch(e){ console.error(e); res.status(500).json({error:String(e.message||e)}); }
});

/* assets come from the CleverTap CSV upload in the app, not MySQL — path kept for parity */
app.get("/rest/v1/rpc/strategy_asset_performance", (req,res)=>res.json([]));

app.listen(PORT, ()=>console.log(`sales-api on http://localhost:${PORT}  (db ${CFG.database}.${CFG.table}, affinity ${ENABLE_AFFINITY})`));
