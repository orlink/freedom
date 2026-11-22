# How law references are written

Every country numbers and cites its laws in its own way. A requirement page quotes the law **in the style of the
jurisdiction**, with the words of the reference (Article, Section, new) **in the reader's language**. Orlin's example:
a Bulgarian paragraph is shown as

| Reader | Shown |
| --- | --- |
| Bulgarian | **Чл. 26** then „(4) Решението, прието с местен референдум, …“ |
| English | **Art. 26** then "(4) A decision adopted by local referendum …" |

and never "Чл. 26, ал. 4 (4) …", which says the paragraph twice.

## The general rule

* The heading names only the article or section: "Чл. 26", "Art. 26", "Section 63", "Article 40".
* The paragraph, point or subsection is the number the quoted text starts with, as it is printed in the law. When a
  quote lacks it (most English translations do), the page adds it in the law's style.
* Several paragraphs of one article, quoted one after another, share one heading.
* A point quoted without its paragraph gets the paragraph's number on a line above it: "(2) …" then "4. …".
* A new article or section proposed by a fix is "Чл. 12а (нов)" / "Art. 12a (new)"; a new paragraph is
  "(3а) (нова)" / "(3a) (new)" under its article.
* Chapters, annexes, schedules and references the page cannot split (points listed by name, amendment notes) keep
  their whole reference as the heading.
* The heading drops the full stop some styles put after the article number ("Чл. 26." in the Bulgarian original),
  because it stands on a line of its own.

## In the data

* `ref` stays in the English form, "Article 26(4)", "Section 63(1)", "Article 40.3.1°". It is the key that fixes,
  approvals and comments are filed under, so it is the same in every language. `bg.ref` ("Чл. 26, ал. 4") is the
  full reference in Bulgarian, used where a reference is quoted in prose (comments, the chat).
* The page parses `ref` to build the heading and number. Write it in one of the forms below, or it falls back to
  showing the whole reference.
* A jurisdiction names its style with `lawStyle` (`"bg"`, `"ch"`, `"ie"`). A law in another style says so with
  `style` (the EU treaties and the ECI Regulation have `"style": "eu"`).
* Quote texts may start with their own number or not. A Bulgarian original keeps its own ("(4) …", "14. …").
* A new style goes in `LAW_STYLES` in js/app.js and in this file.

## The styles

### Bulgaria (`bg`)

| Unit | Bulgarian | English | `ref` |
| --- | --- | --- | --- |
| Article | Чл. 26 | Art. 26 | `Article 26` |
| Paragraph (алинея) | (4) | (4) | `Article 26(4)` |
| Point (точка) | 14. | 14. | `Article 21(1)(14)` or `Article 437(2), item 4` |
| Letter (буква) | а) | a) | |
| Inserted article | Чл. 12а | Art. 12a | `Article 12a` (the letter is Cyrillic in Bulgarian) |
| Chapter, section | Глава втора, раздел III | Chapter II, Section III | whole reference |
| Annex | Приложение № 5, т. 2.1 | Annex 5, item 2.1 | whole reference |

In prose: "чл. 26, ал. 4" / "Article 26(4)"; points "чл. 21, ал. 1, т. 14".

### Switzerland (`ch`)

| Unit | Bulgarian | English | `ref` |
| --- | --- | --- | --- |
| Article | Чл. 10 | Art. 10 | `Article 10` |
| Paragraph (Absatz) | ¹ | ¹ | `Article 10(1)` |
| Inserted paragraph | ¹ᵇⁱˢ | ¹ᵇⁱˢ | `Article 10(1bis)` |
| Letter (Buchstabe) | a. | a. | |
| Inserted article | Чл. 2a | Art. 2a | `Article 2a` |

Paragraph numbers are superscript, as on Fedlex. In prose: "Art. 10 Abs. 1" (German), "Art. 10 para. 1" (English).

### Ireland (`ie`)

Acts of the Oireachtas:

| Unit | Bulgarian | English | `ref` |
| --- | --- | --- | --- |
| Section | Раздел 63 | Section 63 | `Section 63` |
| Subsection | (1) | (1) | `Section 63(1)` |
| Paragraph | (a) | (a) | `Section 131(1)(a)` |
| Inserted section | Раздел 22A | Section 22A | `Section 22A` |
| Schedule, Part | Приложение 7, част 3 | Schedule 7, Part 3 | whole reference |

Statutory instruments number Articles the same way: "Article 2", "(1)".

The Constitution (Bunreacht na hÉireann):

| Unit | Bulgarian | English | `ref` |
| --- | --- | --- | --- |
| Article | Чл. 40 | Article 40 | `Article 40` |
| Section | 3. | 3. | `Article 40.3` |
| Subsection | 1° | 1° | `Article 40.3.1°` |

In prose: "section 63(1)" and "Article 40.3.1°".

### European Union (`eu`)

| Unit | Bulgarian | English | `ref` |
| --- | --- | --- | --- |
| Article | Чл. 11 | Article 11 | `Article 11` |
| Paragraph | 4. | 4. | `Article 11(4)` |
| Point | (a) | (a) | `Article 11(4)(a)` |

In prose: "Article 11(4) TEU" / „чл. 11, параграф 4 от ДЕС“.
