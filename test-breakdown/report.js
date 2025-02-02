import {import_ens_normalize} from '../impls.js';
import {read_labels} from '../ens-labels/labels.js';
import {mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {html_escape, datehash, read_csv} from '../utils.js';
import {UNICODE} from '../ens-normalize.js/derive/unicode-version.js';
import {group_by, explode_cp, hex_cp, parse_cps, compare_arrays, print_section} from '../ens-normalize.js/derive/utils.js';

// "dev" is raffy's local branch, switch to "latest"
let {ens_normalize, ens_tokenize} = await import_ens_normalize('dev'); 

let out_dir, LABELS;
if (process.argv[2] === 'active') { // raffy's hack
	let date = new Date();
	date.setFullYear(2023, 4-1, 1);
	date.setHours(0, 0, 0, 0);	
	out_dir = new URL(`./active-${datehash(date)}/`, import.meta.url);
	let t = Date.now()/1000|0;
	LABELS = JSON.parse(readFileSync(new URL(`../../ens-registered/20230322.json`, import.meta.url))).flatMap(([name, exp]) => parseInt(exp) > t ? name : []);
} else if (process.argv[2] === 'matoken') {
	out_dir = new URL('./refund-matoken/', import.meta.url);
	LABELS = read_csv(new URL(`../refund-proposal/no-refund/20230404_refund_names.csv`, import.meta.url)).map(x => x.fulllabel);
} else {
	out_dir = new URL(`./output-${datehash(new Date())}/`, import.meta.url);
	LABELS = read_labels();
}

console.log(`${LABELS.length} labels`)

// error storage
let same = 0;
let diff_case = 0;
const DIFF = [];

const DATE = new Date().toJSON();
const INSERT_HTML = `<p><b>${LABELS.length}</b> labels — Created <code>${DATE}</code> — <a href="./tally.json">JSON</a></p>`;
const NOT_A_LABEL = 'not a label';

const REPORTS = [
	{
		test: 'disallowed character',
		name: 'disallowed',
		handler: create_disallowed_report,
	},
	{
		test: 'different norm',
		bucket: DIFF, 
		name: 'diff',
		handler: create_diff_report,
	},
	{
		test: 'illegal mixture',
		name: 'mixtures', 
		handler: create_mixture_report,
	},
	{
		test: 'whole-script confusable',
		name: 'wholes', 
		handler: create_whole_report,
	},
	{
		test: 'illegal placement',
		name: 'placement',
		handler: create_placement_report,
	},
	{
		title: 'non-spacing marks',
		test: [
			'duplicate non-spacing marks',
			'excessive non-spacing marks',
		],
		name: 'nsm',
		handler: create_nsm_report,
	},
	{
		test: 'underscore allowed only at start',
	},
	{
		test: 'invalid label extension',
	},
	{
		test: 'empty label',
	},
	{
		test: NOT_A_LABEL,
	}
];
const REPORT_MAP = REPORTS.reduce((a, x) => {
	if (!x.bucket) x.bucket = [];
	if (!Array.isArray(x.test)) x.test = [x.test];
	if (!x.title) x.title = x.test[0];
	for (let key of x.test) a[key] = x;
	return a;
}, {});
function require_report_type(type) {
	let report = REPORT_MAP[type];
	if (!report) throw new Error(`Expected report type: ${type}`);
	return report;
}
function add_error(type, data) {
	require_report_type(type).bucket.push(data);
}

for (let label of LABELS) {
	try {
		if (label.includes('.')) {
			add_error(NOT_A_LABEL, {label});
			continue;
		}
		let norm = ens_normalize(label);		
		if (norm === label) {
			same++;
		} else if (label.toLowerCase() === norm) {
			diff_case++;
		} else {
			DIFF.push({label, norm});
		}
	} catch (err) {
		let {message} = err;
		let index = message.indexOf(':');
		if (index == -1) {
			add_error(message, label);
		} else {
			let type = message.slice(0, index);
			let error = message.slice(index + 1).trim();
			add_error(type, {label, error});
		}
	}
}

console.log();
print_section('Errors');
console.log({same, diff_case});
for (let x of REPORTS) {
	console.log(x.title, x.bucket.length);
}

console.log();
print_section('Reports');
console.log(`Directory: ${out_dir}`);
mkdirSync(out_dir, {recursive: true});
for (let name of readdirSync(out_dir)) {
	unlinkSync(new URL(name, out_dir));
}
writeFileSync(new URL('./tally.json', out_dir), JSON.stringify({
	created: DATE,
	same, diff_case, 
	...Object.fromEntries(REPORTS.map(x => [x.title, x.bucket]))
}));
for (let {name, handler, bucket} of REPORTS) {
	if (!name) continue;
	let file = new URL(`./${name}.html`, out_dir);
	try {
		handler(file, bucket);
		console.log(`Wrote report: ${name}`);
	} catch (err) {
		console.log(`Error writing report: ${name}`);
		throw err;
	}
}
create_index_file(new URL('./index.html', out_dir));

function create_index_file(file) {
	const title = 'Breakdown Reports';
	writeFileSync(file,`
		<!doctype html>
		<html>
		<head>
		<meta charset="utf-8">
		<title>${title}</title>
		<style>
			body {
				margin: 3rem;
			}
			ul {
				font-size: 20pt;
			}
			li {
				padding: 0.5rem;
			}
			li:hover {
				background: #cff;
			}
			li code {
				background: #ddd;
			}
			li a {
				display: block;
			}
			li a code {
				background: #fcc;
			}
		</style>
		</head>
		<body>
		<h1>${title}</h1>
		${INSERT_HTML}
		<ul id="index">
		${REPORTS.map(x => {
			let html = `<code>${x.title}</code> (${x.bucket.length})`;
			if (x.name) {
				html = `<a href="${x.name}.html">${html}</a>`;
			}
			return `<li>${html}</li>`
		}).join('')}
		</ul>
		</body>
		</html>
	`);
}

function create_diff_report(file, errors) {
	// TODO: can we auto-derive this from chars-mapped.js with an extra annotation?
	let cats = [
		{name: 'Arabic', cps: '6F0..6F3 6F7..6F9'},
		{name: 'Hyphen', cps: '2010..2015 2212 2043 FE58 23E4 23AF 2E3A 2E3B'},
		{name: 'Apostrophe', cps: '27'},
		{name: 'Negative Circled Digit', cps: '24EB..24F4'},
		{name: 'Double Circled Digit', cps: '24F5..24FE'},
		{name: 'Dingbat Negative Circled Digit', cps: '24FF 2776..277F'},
		{name: 'Dingbat Circled Sans-serif Digit', cps: '1F10B 2780..2789'},
		{name: 'Dingbat Negative Circled Sans-serif Digit', cps: '1F10C 278A..2793'},
		{name: 'Dingbat Negative Circled Sans-serif Letter', cps: '1F150..1F169'},
		{name: '[IDNA] Circled Digit', cps: '24EA 2460..2469'},
		{name: '[IDNA] Circled Letter', cps: '24D0..24E9'},
		{name: '[IDNA] Demoji', cps: '2122 2139 24C2 3297 3299 1F201 1F202 1F21A 1F22F 1F232 1F233 1F234 1F235 1F236 1F237 1F238 1F239 1F23A 1F250 1F251'},
	];
	let catchall = [];
	let wrong_emoji = [];
	for (let cat of cats) {
		cat.set = new Set(parse_cps(cat.cps));
		cat.errors = [];
	}
	for (let error of errors) {
		let {label, norm} = error;
		let tokens = error.tokens = ens_tokenize(label);
		let normed = new Set(explode_cp(norm));		
		let complement = [...new Set(explode_cp(label))].filter(cp => !normed.has(cp));
		let matched = cats.filter(cat => complement.some(cp => cat.set.has(cp)));
		if (matched.length === 1) {
			matched[0].errors.push(error);
		} else if (tokens.some(t => t.emoji && compare_arrays(t.input, t.cps)) && norm === String.fromCodePoint(...tokens.flatMap(t => t.emoji ? t.cps : (t.cps || t.cp)))) {
			wrong_emoji.push(error);
		} else {
			catchall.push(error);
		}
	}
	const EMOJI = 'Unnormalized Emoji';
	cats.push({name: EMOJI, errors: wrong_emoji});
	cats.push({name: 'Everything Else', errors: catchall});
	for (let cat of cats) {		
		cat.slug = cat.name.toLowerCase().replaceAll(' ', '_');
	}
	cats = cats.filter(x => x.errors.length > 0);
	cats.sort((a, b) => b.errors.length - a.errors.length);

	function hex_diff(tokens) {
		return tokens.map(t => {
			if (t.type === 'emoji' && compare_arrays(t.input, t.cps)) {
				return `<span class="emoji">[${t.input.map(hex_cp).join(' ')} → ${t.cps.map(hex_cp).join(' ')}]</span>`;
			} else if (t.type === 'nfc') {
				return `<span class="nfc">${t.input.map(hex_cp).join(' ')} → ${t.cps.map(hex_cp).join(' ')}</span>`;
			} else if (t.type === 'mapped') {
				return `<span class="mapped">[${hex_cp(t.cp)} → ${t.cps.map(hex_cp).join(' ')}]</span>`;
			} else if (t.type === 'ignored') {
				return `<span class="ignored">[${hex_cp(t.cp)}]</span>`;
			} else {
				return t.cps.map(hex_cp).join(' ');
			}
		}).join(' ');
	}
	let total = cats.reduce((a, cat) => a + cat.errors.length, 0);
	writeFileSync(file, `
		${create_header(`Different Norm(${errors.length})`)}
		<ul>
		${cats.map(({name, slug, errors}) => {
			return `<li><a href="#${slug}">${name}</a> (${errors.length}) — <b>${(100 * errors.length / total).toFixed(2)}%</b></li>`;
		}).join('\n')}
		</ul>
		${cats.map(({name, slug, set, errors}) => {	
			let html;
			if (set) {
				html = `
					<ol>
						${[...set].map(cp => `<li><code>${hex_cp(cp)}</code> (${UNICODE.safe_str(cp)}) ${UNICODE.get_name(cp, true)}</li>`).join('\n')}
					</ol>
					<table>
						<tr><th>#</th><th>Before</th><th>After</th><th>Hex Diff</th></tr>
						${errors.map(({label, norm, tokens}, i) => {
							return `<tr>
								<td>${i+1}</td>
								<td class="form"><a class="limit" data-name="${encodeURIComponent(label)}">${html_escape_marked_tokens(tokens, set, false)}</a></td>
								<td class="form"><a class="limit" data-name="${encodeURIComponent(norm)}">${html_escape_marked_tokens(tokens, set, true)}</a></td>
								<td class="hex">${hex_diff(tokens)}</td>
							</tr>`;
						}).join('\n')}
					</table>
				`;
			} else if (name === EMOJI) {
				html = `<table>
					<tr><th>#</th><th>Form</th><th>Hex Diff</th></tr>
					${errors.map(({label, tokens}, i) => {
						return `<tr>
							<td>${i+1}</td>
							<td class="form"><a class="limit" data-name="${encodeURIComponent(label)}">${html_escape(label)}</a></td>	
							<td class="hex">${hex_diff(tokens)}</td>
						</tr>`;
					}).join('\n')}
				</table>`;
			} else { 
				html = `<table>
					<tr><th>#</th><th>Before</th><th>After</th><th>Hex Diff</th></tr>
					${errors.map(({label, norm, tokens}, i) => {
						return `<tr>
							<td>${i+1}</td>
							<td class="form"><a class="limit" data-name="${encodeURIComponent(label)}">${html_escape(label)}</a></td>	
							<td class="form"><a class="limit" data-name="${encodeURIComponent(norm)}">${html_escape(norm)}</a></td>	
							<td class="hex">${hex_diff(tokens)}</td>
						</tr>`;
					}).join('\n')}
				</table>`;
			}
			return `<h2><a name="${slug}">${name} (${errors.length})</a></h2>${html}`;
		}).join('\n')}
		<script>
		for (let a of document.querySelectorAll('a[data-name]')) {
			a.target = '_blank';
			a.href = 'https://adraffy.github.io/ens-normalize.js/test/resolver.html#' + a.dataset.name;
		}
		</script>
		</body>
		</html>
	`);
}

function html_escape_marked_tokens(tokens, set, norm) {
	return tokens.map(t => {
		if (t.type === 'mapped' && set.has(t.cp)) {
			return `<span>${html_escape(String.fromCodePoint(...(norm ? t.cps : [t.cp])))}</span>`;
		} else {
			return html_escape(String.fromCodePoint(...(t.cps ?? [t.cp])));
		}	
	}).join('');
}


function create_disallowed_report(file, errors) {
	let types = [...group_by(errors, x => x.error).entries()].map(([type, errors]) => {
		let slug = type.slice(type.indexOf('{') + 1, -1);
		let cp = parseInt(slug, 16);
		let cm = UNICODE.cm.has(cp);
		return {type, slug, cp, errors, cm};
	}).sort((a, b) => {		
		let c = b.errors.length - a.errors.length;
		if (c == 0) c = a.cp - b.cp;
		return c;
	});
	let cats = [
		{name: 'Characters', types: types.filter(x => !x.cm)},
		{name: 'Combining Marks', types: types.filter(x => x.cm)}
	];
	for (let cat of cats) {		
		cat.slug = cat.name.toLowerCase().replaceAll(' ', '_');
		cat.total = cat.types.reduce((a, x) => a + x.errors.length, 0);
	}
	writeFileSync(file, `
		${create_header(`Disallowed Characters (${errors.length})`)}
		<ul>
		${cats.map(({name, slug, types, total}) => {
			return `<li><a href="#${slug}">${name}</a> (${types.length} chars in ${total} names) — <b>${(100 * total / errors.length).toFixed(2)}%</b></li>`;
		}).join('\n')}
		</ul>
		${cats.map(({name, slug, types}) => {	
			return `
				<h2 id="${slug}">${name} (${types.length})</h2>
				<div class="cloud">
				${types.map(({type, slug, errors}) => {
					return `<a href="#${slug}"><code>${type}</code> (${errors.length})</a>`;
				}).join('\n')}
				</div>
				${types.map(({type, slug, cp, errors}) => {
					return `
						<h3 id="${slug}"><code>${type}</code> ${UNICODE.get_name(cp, true)} (${errors.length})</h2>
						<table>
							<tr><th>#</th><th>Label</th><th>Hex</th></tr>
							${errors.map(({label}, i) => {
								return `<tr>
									<td>${i+1}</td>
									<td class="form"><a class="limit" data-name="${encodeURIComponent(label)}">${html_escape(label)}</a></td>
									<td class="hex"><div class="limit">${explode_cp(label).map(x => {
										let hex = hex_cp(x);
										if (x === cp) hex = `<span>${hex}</span>`;
										return hex;
									}).join(' ')}</div></td>
								</tr>`;
							}).join('\n')}
						</table>
					`;
				}).join('\n')}
			`;
		}).join('\n')}
		<script>
		for (let a of document.querySelectorAll('a[data-name]')) {
			a.target = '_blank';
			a.href = 'https://adraffy.github.io/ens-normalize.js/test/resolver.html#' + a.dataset.name;
		}
		</script>
		</body>
		</html>
	`);
}

function create_nsm_report(file, errors) {
	for (let x of errors) {
		x.group = x.error.split(' ', 2)[0];
	}
	writeFileSync(file, `
		${create_header(`Non-spacing Marks (${errors.length})`)}
		<table>
		<tr>
			<th>#</th>
			<th>Label</th>
			<th>Error</th>
		</tr>
		${errors.sort((a, b) => a.error.localeCompare(b.error)).map(({label, error, group}, i, v) => {
			return `<tr${i > 0 && v[i-1].group === group ? '' : ' class="sep"'}>
				<td class="idx">${i+1}</td>
				<td class="form nsm"><a data-name="${encodeURIComponent(label)}">${[...label].map(html_escape).join('\xAD')}</a></td>
				<td class="error">${error}</td>
			</tr>`;
		}).join('\n')}
		</table>
		<script>
		for (let a of document.querySelectorAll('a[data-name]')) {
			a.target = '_blank';
			a.href = 'https://adraffy.github.io/ens-normalize.js/test/resolver.html#' + a.dataset.name;
		}
		</script>
		</body>
		</html>
	`);
}

function create_cm_report(file, errors) {
	for (let x of errors) {
		x.group = x.error.split(' ', 2)[0];
	}
	writeFileSync(file, `
		${create_header(`Excess Combining Marks (${errors.length})`)}
		<table>
		<tr>
			<th>#</th>
			<th>Label</th>
			<th>Error</th>
		</tr>
		${errors.sort((a, b) => a.error.localeCompare(b.error)).map(({label, error, group}, i, v) => {
			return `<tr${i > 0 && v[i-1].group === group ? '' : ' class="sep"'}>
				<td class="idx">${i+1}</td>
				<td class="form"><a data-name="${encodeURIComponent(label)}">${html_escape(label)}</a></td>
				<td class="error">${error}</td>
			</tr>`;
		}).join('\n')}
		</table>
		<script>
		for (let a of document.querySelectorAll('a[data-name]')) {
			a.target = '_blank';
			a.href = 'https://adraffy.github.io/ens-normalize.js/test/resolver.html#' + a.dataset.name;
		}
		</script>
		</body>
		</html>
	`);
}

function create_placement_report(file, errors) {
	let types = [...group_by(errors, x => x.error.split(':', 2)[0]).entries()].map(([type, errors]) => {
		return {type, slug: type.replace(/\s+/, '_'), errors};
	}).sort((a, b) => b.errors.length - a.errors.length);
	writeFileSync(file, `
		${create_header(`Illegal Placement (${errors.length})`)}
		<ul>
		${types.map(({type, slug, errors}) => {
			return `<li><a href="#${slug}">${type} (${errors.length})</a></li>`;
		}).join('\n')}
		</ul>
		${types.map(({type, slug, errors}) => `
			<h2><a name="${slug}">${type} (${errors.length})</a></h2>
			<table>
				<tr><th>#</th><th>Label</th></tr>
				${errors.map(({label}, i) => {
					return `<tr><td>${i+1}</td><td class="form"><a data-name="${encodeURIComponent(label)}">${html_escape(label)}</a></td></tr>`;
				}).join('\n')}
			</table>
		`).join('\n')}
		</table>
		<script>
		for (let a of document.querySelectorAll('a[data-name]')) {
			a.target = '_blank';
			a.href = 'https://adraffy.github.io/ens-normalize.js/test/resolver.html#' + a.dataset.name;
		}
		</script>
		</body>
		</html>
	`);
}

function create_mixture_report(file, errors) {
	writeFileSync(file, `
		${create_header(`Illegal Mixtures (${errors.length})`)}
		<table>
		<tr>
			<th>#</th>
			<th>Label</th>
			<th>Error</th>
		</tr>
		${errors.sort((a, b) => a.error.localeCompare(b.error)).map(({label, error}, i, v) => {
			return `<tr${i > 0 && v[i-1].error === error ? '' : ' class="sep"'}>
				<td class="idx">${i+1}</td>
				<td class="form"><a data-name="${encodeURIComponent(label)}">${html_escape(label)}</a></td>
				<td class="error">${error}</td>
			</tr>`;
		}).join('\n')}
		</table>
		<script>
		for (let a of document.querySelectorAll('a[data-name]')) {
			a.target = '_blank';
			a.href = 'https://adraffy.github.io/ens-normalize.js/test/resolver.html#' + a.dataset.name;
		}
		</script>
		</body>
		</html>
	`);
}

function create_whole_report(file, errors) {
	writeFileSync(file, `
		${create_header(`Whole-script Confusables (${errors.length})`)}
		<table>
		<tr>
			<th>#</th>
			<th>Label</th>
			<th>Conflict</th>
		</tr>
		${errors.sort((a, b) => a.error.localeCompare(b.error)).map(({label, error}, i, v) => {
			return `<tr${i > 0 && v[i-1].error === error ? '' : ' class="sep"'}>
				<td class="idx">${i+1}</td>
				<td class="form"><a data-name="${encodeURIComponent(label)}">${html_escape(label)}</a></td>
				<td>${error}</td>
			</tr>`;
		}).join('\n')}
		</table>
		<script>
		for (let a of document.querySelectorAll('a[data-name]')) {
			a.target = '_blank';
			a.href = 'https://adraffy.github.io/ens-normalize.js/test/confused.html#' + a.dataset.name;
		}
		</script>
		</body>
		</html>
	`);
}

function create_header(title) {
	return `
	<!doctype html>
	<html>
	<head>
	<meta charset="utf-8">
	<title>${title}</title>
	<style>
		body {
			margin: 3rem;
		}
		.cloud {
			display: flex;
			flex-wrap: wrap;
			gap: 4px;
		}
		.cloud a {
			background: #eee;
			border: 1px solid #ccc;
			padding: 2px 4px;
			border-radius: 4px;
			text-decoration: none;
		}
		.cloud a:hover {
			cursor: pointer;
			background: #cff;
		}
		table {
			border-collapse: collapse;
			border: 2px solid #888;
		}
		table a {
			text-decoration: none;
			color: #000;
		}
		table a:hover {
			text-decoration: underline;
			cursor: pointer;
		}
		tr.sep {
			border-top: 2px solid #888;
		}
		tr:nth-child(odd) { 
			background: #eee; 
		}
		th, td {
			border: 1px solid #ccc;
			padding: 2px 4px;
			text-align: center;
		}
		.limit {
			display: block;
			max-height: 8rem;
			overflow-y: auto;
			overflow-wrap: anywhere;
		}
		td.idx {
			color: #888;
		}
		td.form {
			font-size: 20pt;
		}
		td.form.nsm {
			padding: 4rem 2rem;
			overflow: hidden;
		}
		td span.emoji {
			color: #00f;
		}
		td span.ignored {
			color: #aaa;
		}
		td span.nfc {
			color: #c80;
		}
		td span.mapped {
			color: #66f;
		}
		td span {
			color: #d00;
		}
		td.hex {
			text-align: left;
			font: 10pt monospace;
		}
		td.error {
			white-space: nowrap;
		}
	</style>
	</head>
	<body>
	<h1>${title}</h1>
	${INSERT_HTML}`;
}
