import { categorySpecsA } from './quality-rubric-parts-a.mjs';
import { categorySpecsB } from './quality-rubric-parts-b.mjs';
import { categorySpecsC } from './quality-rubric-parts-c.mjs';

const RUBRIC_VERSION='youtube-quality-rubric.v1';
const baseCategories=[...categorySpecsA,...categorySpecsB,...categorySpecsC];

export const profiles={
  explainer:{id:'explainer',name:'解説・考察',description:'論理、証拠、理解、視聴満足を重視する標準。',weights:{promise:7,hook:10,structure:12,pacing:10,cuts:9,visuals:11,captions:9,audio:10,motion:5,clarity:7,trust:6,ending:4}},
  entertainment:{id:'entertainment',name:'エンタメ・リアクション',description:'初動、感情、テンポ、音響、画面変化を相対的に重視。',weights:{promise:6,hook:12,structure:9,pacing:12,cuts:10,visuals:12,captions:7,audio:12,motion:7,clarity:4,trust:4,ending:5}},
  documentary:{id:'documentary',name:'ドキュメンタリー',description:'物語、証拠、映像、音響、信頼性を重視。',weights:{promise:6,hook:8,structure:14,pacing:8,cuts:9,visuals:13,captions:6,audio:12,motion:4,clarity:6,trust:10,ending:4}},
  tutorial:{id:'tutorial',name:'チュートリアル',description:'理解、手順、図解、字幕、再現性を重視。',weights:{promise:7,hook:8,structure:14,pacing:9,cuts:6,visuals:12,captions:9,audio:8,motion:3,clarity:13,trust:7,ending:4}},
};

export const gates=[
  {id:'promise-mismatch',name:'約束不一致',cap:59,description:'タイトル・サムネと本編の主要価値が一致しない。'},
  {id:'critical-factual-error',name:'重大な事実誤認',cap:49,description:'結論に影響する誤情報、誤引用、誤認が残る。'},
  {id:'dialogue-unintelligible',name:'音声明瞭度破綻',cap:49,description:'重要区間の言葉が聞き取れない、または音割れがある。'},
  {id:'caption-desync',name:'字幕同期破綻',cap:59,description:'フルテロップ指定で6フレーム超の遅延または先行が反復する。'},
  {id:'technical-failure',name:'技術的破損',cap:39,description:'映像・音声欠落、デコードエラー、尺ずれ、黒フレームなどがある。'},
  {id:'rights-unclear',name:'権利条件不明',cap:59,description:'素材、音源、引用の利用条件または出典を確認できない。'},
  {id:'human-review-missing',name:'人間全編レビュー未実施',cap:74,description:'機械検査だけで、人間が全編を視聴していない。'},
];

export const scoreBands=[
  {min:0,max:19,label:'破綻',description:'視聴者が継続する理由より離脱要因が明確に多い。'},
  {min:20,max:39,label:'試作',description:'最低限見られるが、構成・映像・音の複数領域が未完成。'},
  {min:40,max:59,label:'公開前',description:'基礎は成立するが、視聴維持と満足を安定して作れない。'},
  {min:60,max:74,label:'合格',description:'大きな破綻がなく、対象視聴者へ一貫した価値を届ける。'},
  {min:75,max:89,label:'強い',description:'構成・編集・音響が相互に補強し、再視聴や共有を期待できる。'},
  {min:90,max:100,label:'卓越',description:'公開実績と人間評価でも優位性が再現され、弱点が限定的。'},
];

export const sources=[
  {id:'yt-retention',type:'official',title:'YouTube: Measure key moments for audience retention',url:'https://support.google.com/youtube/answer/9314415',note:'最初の30秒、Top moments、Spikes、Dips、後半の強い場面の前倒し。'},
  {id:'yt-performance',type:'official',title:'YouTube: Understand content performance for recommendations',url:'https://support.google.com/youtube/answer/16559650',note:'Appeal・Engagement・Satisfaction、期待一致、初動のフック、全編の価値。'},
  {id:'yt-recommendation',type:'official',title:'YouTube recommendation system',url:'https://support.google.com/youtube/answer/16533387',note:'アルゴリズムより視聴者満足を優先し、長期的満足を目的とする。'},
  {id:'yt-thumbnail',type:'official',title:'YouTube: Thumbnail & title tips',url:'https://support.google.com/youtube/answer/12340300',note:'正確で簡潔なタイトル、複雑すぎないサムネ、端末差、CTR検証。'},
  {id:'yt-engagement',type:'official',title:'YouTube engagement analytics',url:'https://support.google.com/youtube/answer/9313698',note:'Watch time、Average view duration、Audience retention。'},
  {id:'w3c-captions',type:'standard',title:'W3C WAI: Captions/Subtitles',url:'https://www.w3.org/WAI/media/av/captions/',note:'自動字幕だけでは不十分。発話と重要音を正確かつ同期して字幕化。'},
  {id:'wcag-captions',type:'standard',title:'WCAG 2.2: Captions (Prerecorded)',url:'https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded',note:'録画済み音声内容に同期字幕を提供し、重要な非発話音も扱う。'},
  {id:'ebu-r128',type:'standard',title:'EBU R 128 Loudness',url:'https://tech.ebu.ch/loudness',note:'ピークだけでなくIntegrated、Short-term、True Peak、Loudness Rangeで評価。'},
  {id:'effective-videos',type:'research',title:'Effective Educational Videos',url:'https://pmc.ncbi.nlm.nih.gov/articles/PMC5132380/',note:'シグナリング、分節化、不要情報の除去、補完的な音声と映像。'},
  {id:'cognitive-load',type:'research',title:'Optimizing Instructional Materials',url:'https://pmc.ncbi.nlm.nih.gov/articles/PMC7940870/',note:'Multimedia、Spatial contiguity、Coherence、Signaling、Segmenting。'},
  {id:'segmenting',type:'research',title:'CTML and online multimedia lessons',url:'https://pmc.ncbi.nlm.nih.gov/articles/PMC9762622/',note:'分節化は保持・転移・認知負荷を改善するが、最適粒度は内容依存。'},
  {id:'fast-cuts',type:'research',title:'Chaotic and Fast Audiovisuals',url:'https://doi.org/10.1016/j.neuroscience.2018.10.025',note:'高速・非組織的編集は注意を広げる一方、意識的処理を低下させ得る。'},
  {id:'signaling',type:'research',title:'The Influence of Signaling on Multimedia Learning',url:'https://pmc.ncbi.nlm.nih.gov/articles/PMC8593463/',note:'視覚的シグナリングは重要情報へ注意を導き、転移成績を改善した。'},
];

export const releases=[
  {id:'edit-v0.1',kind:'editing-test',date:'2026-07-21T19:10:00+09:00',title:'無音除去版',headlineScore:10,humanScore:10,deprecatedMachineScore:null,durationSeconds:322.3,metrics:{selects:175,captions:77,captionMode:'YouTube自動字幕',bgm:false,sfx:0,loudness:'-31.4 dBFS平均'},changes:['長い無音と一部反復を削除','字幕を焼き込み','長尺レンダーのフレーム累積誤差を修正'],tests:['尺誤差0秒','全編デコード合格','0.7秒以上のデジタル無音0件'],issues:['175区間の細切れ','字幕誤認識','画面変化ほぼなし','音量が小さい','発話順を維持しただけ']},
  {id:'edit-v0.2',kind:'editing-test',date:'2026-07-21T23:45:00+09:00',title:'視聴維持再構成版',headlineScore:15,humanScore:15,deprecatedMachineScore:86,durationSeconds:133.5,metrics:{selects:8,captions:22,captionMode:'要点字幕',bgm:false,sfx:0,loudness:'-16.6 LUFS'},changes:['結論を冒頭へ移動','8区間・3章へ再構成','パンチイン12件','音声を補正'],tests:['尺誤差0秒','True Peak -1.54 dBTP','マイクロカット0件'],issues:['フルテロップではない','BGM・SEなし','外部資料なし','音声接続に不自然な箇所','旧機械採点が人間評価を過大推定']},
  {id:'edit-v0.3',kind:'editing-test',date:'2026-07-22T01:00:00+09:00',title:'フルテロップ・音響版',headlineScore:20,humanScore:20,deprecatedMachineScore:100,durationSeconds:140.8,metrics:{selects:8,captions:47,captionMode:'人手補正フルテロップ',captionCoverage:'100%',captionOnset:'最大0.01F',bgm:'Feedback Dreams',sfx:8,loudness:'-15.74 LUFS'},changes:['発話カバー率100%のフルテロップ','字幕開始最大0.01フレーム','BGMダッキング','SE 8箇所','切り出し位置を再調整'],tests:['尺誤差0秒','全編デコード合格','True Peak -2.46 dBTP','字幕最大2行・1行18文字'],issues:['画面の情報価値が低い','資料・比較・図解が不足','BGM・SEが構成上の意味を十分持たない','音声接続に人間品質の弱点','旧機械点100は廃止']},
  {id:'tool-v0.4',kind:'tool-release',date:'2026-07-22T02:25:00+09:00',title:'Quality Lab基準・履歴画面',headlineScore:null,humanScore:null,deprecatedMachineScore:null,changes:['12カテゴリ・82項目','0〜4段階の項目別基準','重大欠陥による点数上限','制作品質・人間視聴・公開実績を分離','版比較・折れ線・テスト履歴・根拠資料をSP最適化'],tests:[],issues:['動画自体の品質はこの版では未変更']},
];

const makeLevels=(criterion,maxPoints)=>[
  {level:0,label:'破綻',ratio:0,points:0,description:criterion.fail},
  {level:1,label:'弱い',ratio:.25,points:+(maxPoints*.25).toFixed(2),description:`${criterion.fail}は一部改善したが、標準条件には届かない。`},
  {level:2,label:'標準',ratio:.5,points:+(maxPoints*.5).toFixed(2),description:criterion.standard},
  {level:3,label:'強い',ratio:.75,points:+(maxPoints*.75).toFixed(2),description:`${criterion.excellent}にほぼ達し、残る弱点は限定的。`},
  {level:4,label:'卓越',ratio:1,points:+maxPoints.toFixed(2),description:criterion.excellent},
];

export function categoriesForProfile(profileId='explainer'){
  const profile=profiles[profileId]||profiles.explainer;
  return baseCategories.map(category=>{
    const weight=profile.weights[category.id];
    const maxPoints=weight/category.criteria.length;
    return {...category,weight,criteria:category.criteria.map(item=>({...item,maxPoints:+maxPoints.toFixed(2),levels:makeLevels(item,maxPoints)}))};
  });
}

export function scoreAssessment({profileId='explainer',levels={},activeGates=[]}={}){
  const categories=categoriesForProfile(profileId);
  const categoryScores=categories.map(category=>{
    const exactCriterionPoints=category.weight/category.criteria.length;
    const score=category.criteria.reduce((sum,item)=>{
      const level=Math.max(0,Math.min(4,Number(levels[item.id]??0)));
      return sum+exactCriterionPoints*(level/4);
    },0);
    return {id:category.id,name:category.name,score:+score.toFixed(2),maxScore:category.weight};
  });
  const rawScore=categoryScores.reduce((sum,row)=>sum+row.score,0);
  const matched=gates.filter(gate=>activeGates.includes(gate.id));
  const cap=matched.length?Math.min(...matched.map(gate=>gate.cap)):100;
  const finalScore=Math.min(rawScore,cap);
  return {rawScore:+rawScore.toFixed(2),finalScore:+finalScore.toFixed(2),cap,categoryScores,activeGates:matched,band:scoreBands.find(band=>finalScore>=band.min&&finalScore<=band.max)};
}

export function getQualityLabData(profileId='explainer'){
  const profile=profiles[profileId]||profiles.explainer;
  const categories=categoriesForProfile(profile.id);
  return {
    version:RUBRIC_VERSION,
    generatedAt:'2026-07-22T02:25:00+09:00',
    profile,
    profiles:Object.values(profiles),
    categories,
    categoryCount:categories.length,
    criterionCount:categories.reduce((sum,category)=>sum+category.criteria.length,0),
    gates,scoreBands,sources,releases,
    scoringModel:{
      levelScale:'0〜4',
      craftScore:'各項目のレベル点をカテゴリ重みで合計し、重大ゲートが発動した場合は上限を適用。',
      humanScore:'全編を視聴した人間の理解・退屈・違和感・満足度。見出し点はこの値を優先。',
      audienceScore:'公開後の30秒維持率、平均視聴率、離脱、再視聴、共有、満足度。データがない場合は未算出。',
      deprecatedPolicy:'旧機械点86・100は参考値としてのみ残し、品質点には使用しない。',
    },
  };
}

if(import.meta.url===`file://${process.argv[1]}`){
  const data=getQualityLabData(process.argv[2]||'explainer');
  console.log(JSON.stringify({version:data.version,categories:data.categoryCount,criteria:data.criterionCount,weight:data.categories.reduce((sum,row)=>sum+row.weight,0),profiles:data.profiles.length,sources:data.sources.length,releases:data.releases.length},null,2));
}
