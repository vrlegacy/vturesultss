import { useMemo, useState, useEffect } from 'react'
import type { ChangeEvent } from 'react'
import * as pdfjsLib from 'pdfjs-dist'

type GradeMap = Record<string, number>

type Scheme = {
  id: string
  label: string
  description: string
  gradePoints: GradeMap
  markRanges: Array<{ min: number; grade: string }>
}

type SubjectRow = {
  code: string
  name: string
  credits: number
  grade: string
  total?: number
  result?: string
}

type RecalcSubjectRow = SubjectRow & {
  isRecalculated: boolean
  recalculatedGrade?: string
  recalculatedPoints?: number
}

type ParsedSemester = {
  semester: number | null
  schemeId: string
  sourceName: string
  rawText: string
  subjects: SubjectRow[]
}

type SemesterResult = ParsedSemester & {
  sgpa: number | null
  totalCredits: number
  earnedCredits: number
  cgpaCredits: number
  creditPoints: number
}

type CgpaMode = 'regulation-formula' | 'annexure-backlog'

const schemes: Scheme[] = [
  {
    id: 'vtu-2022',
    label: 'VTU 2022 Scheme (CBCS)',
    description: 'Official 2022 Scheme (Regulations PDF): O=10, A+=9, A=8, B+=7, B=6, C=5, P=4, F=0, ABS=0',
    gradePoints: { O: 10, 'A+': 9, A: 8, 'B+': 7, B: 6, C: 5, P: 4, F: 0, ABS: 0 },
    markRanges: [
      { min: 90, grade: 'O' },
      { min: 80, grade: 'A+' },
      { min: 70, grade: 'A' },
      { min: 60, grade: 'B+' },
      { min: 55, grade: 'B' },
      { min: 50, grade: 'C' },
      { min: 40, grade: 'P' },
      { min: 0, grade: 'F' },
    ],
  },
  {
    id: 'vtu-legacy-2018-2021',
    label: 'VTU 2018/2021 Scheme',
    description: 'Legacy S-A-B-C-D-E Grading: S=10, A=9, B=8, C=7, D=6, E=5, P=4, F=0, ABS=0',
    gradePoints: { S: 10, A: 9, B: 8, C: 7, D: 6, E: 5, P: 4, F: 0, ABS: 0 },
    markRanges: [
      { min: 90, grade: 'S' },
      { min: 80, grade: 'A' },
      { min: 70, grade: 'B' },
      { min: 60, grade: 'C' },
      { min: 55, grade: 'D' },
      { min: 50, grade: 'E' },
      { min: 40, grade: 'P' },
      { min: 0, grade: 'F' },
    ],
  },
]



pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

function formatGpa(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value)) {
    return '--'
  }
  return value.toFixed(3)
}

function getOrdinalSuffix(num: number): string {
  const j = num % 10
  const k = num % 100
  if (j === 1 && k !== 11) {
    return 'st'
  }
  if (j === 2 && k !== 12) {
    return 'nd'
  }
  if (j === 3 && k !== 13) {
    return 'rd'
  }
  return 'th'
}

function normalizeGrade(value: string) {
  return value.toUpperCase().replace(/\s+/g, '')
}

function inferGradeFromMarks(total: number, scheme: Scheme) {
  const bucket = scheme.markRanges.find((range) => total >= range.min)
  return bucket?.grade ?? 'F'
}

function inferCredits(code: string, name: string) {
  const upperCode = code.toUpperCase()
  const upperName = name.toUpperCase()

  if (upperName.includes('PROJECT PHASE')) {
    return 2
  }

  if (upperName.includes('LAB')) {
    return 1
  }

  if (upperName.includes('PHYSICAL EDUCATION') || upperName.includes('KNOWLEDGE SYSTEM')) {
    return 1
  }

  if (upperCode.includes('UH') || upperCode.includes('IKS')) {
    return 1
  }

  return 3
}

function parseVtuPdfStyleText(rawText: string, scheme: Scheme) {
  const normalizedText = rawText.replace(/\s+/g, ' ').trim()
  const semesterMatch = normalizedText.match(/Semester\s*:\s*(\d{1,2})/)
  const semester = semesterMatch ? Number(semesterMatch[1]) : null
  const firstSemesterStart = normalizedText.search(/Semester\s*:\s*\d{1,2}\s+Subject Code/i)
  const nextSemesterMatch =
    firstSemesterStart >= 0
      ? normalizedText.slice(firstSemesterStart + 1).match(/Semester\s*:\s*\d{1,2}\s+Subject Code/i)
      : null
  const firstBlock =
    firstSemesterStart >= 0
      ? nextSemesterMatch && nextSemesterMatch.index !== undefined
        ? normalizedText.slice(firstSemesterStart, firstSemesterStart + 1 + nextSemesterMatch.index)
        : normalizedText.slice(firstSemesterStart)
      : normalizedText
  const rowPattern =
    /([A-Z]{3,6}\d{3,4}[A-Z]?)\s+(.+?)\s+(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s+([PFAWX]|NE)\s+(\d{4}-\d{2}-\d{2})/g

  const subjects: SubjectRow[] = []

  for (const match of firstBlock.matchAll(rowPattern)) {
    const code = match[1].trim()
    const name = match[2].trim()
    const total = Number(match[5])
    const result = normalizeGrade(match[6])
    const grade = result === 'P' ? inferGradeFromMarks(total, scheme) : result

    subjects.push({
      code,
      name,
      credits: inferCredits(code, name),
      grade,
      total,
      result,
    })
  }

  return { semester, subjects }
}

function parseSemesterText(rawText: string, scheme: Scheme, sourceName: string): ParsedSemester {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const semesterLine = lines.find((line) => /semester/i.test(line))
  const semesterMatch = semesterLine?.match(/(\d{1,2})/)
  const semester = semesterMatch ? Number(semesterMatch[1]) : null
  const pdfParsed = parseVtuPdfStyleText(rawText, scheme)

  if (pdfParsed.subjects.length) {
    return {
      semester: pdfParsed.semester ?? semester,
      schemeId: scheme.id,
      sourceName,
      rawText,
      subjects: pdfParsed.subjects,
    }
  }

  const subjects = lines
    .map((line) => {
      const match = line.match(
        /^([A-Z0-9-]{5,20})\s+(.+?)\s+(\d+(?:\.\d+)?)\s+([A-Za-z+ ]{1,5}|ABS)$/i,
      )

      if (!match) {
        return null
      }

      return {
        code: match[1].trim(),
        name: match[2].trim(),
        credits: Number(match[3]),
        grade: normalizeGrade(match[4]),
      } satisfies SubjectRow
    })
    .filter((row): row is SubjectRow => row !== null)

  return {
    semester,
    schemeId: scheme.id,
    sourceName,
    rawText,
    subjects,
  }
}

function htmlToText(rawHtml: string) {
  const parser = new DOMParser()
  const doc = parser.parseFromString(rawHtml, 'text/html')
  return doc.body.textContent ?? rawHtml
}

async function pdfToText(file: File) {
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const pages: string[] = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const content = await page.getTextContent()
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s{2,}/g, ' ')
    pages.push(text)
  }

  return pages.join('\n')
}

function calculateSemesterResult(parsed: ParsedSemester, scheme: Scheme): SemesterResult {
  let weightedTotal = 0
  let totalCredits = 0
  let earnedCredits = 0
  let cgpaCredits = 0

  for (const subject of parsed.subjects) {
    const gradePoint = scheme.gradePoints[subject.grade]
    totalCredits += subject.credits

    if (typeof gradePoint === 'number') {
      weightedTotal += gradePoint * subject.credits

      if (gradePoint > 0) {
        earnedCredits += subject.credits
        cgpaCredits += subject.credits
      }
    }
  }

  const sgpa = totalCredits > 0 ? Number((weightedTotal / totalCredits).toFixed(2)) : null

  return {
    ...parsed,
    sgpa,
    totalCredits,
    earnedCredits,
    cgpaCredits,
    creditPoints: weightedTotal,
  }
}

function calculateOverallCgpa(results: SemesterResult[], mode: CgpaMode, scheme: Scheme) {
  // Group all subjects by code
  const courses: Record<string, { code: string; credits: number; attempts: Array<{ grade: string; points: number }> }> = {};

  results.forEach((res) => {
    res.subjects.forEach((sub) => {
      const code = sub.code.toUpperCase().trim();
      const points = scheme.gradePoints[sub.grade] ?? 0;
      if (!courses[code]) {
        courses[code] = {
          code: sub.code,
          credits: sub.credits,
          attempts: []
        };
      }
      courses[code].attempts.push({ grade: sub.grade, points });
    });
  });

  let totalWeightedPoints = 0;
  let totalCgpaCredits = 0;

  Object.values(courses).forEach((course) => {
    // Find the best attempt (attempt with the highest points)
    const bestAttempt = course.attempts.reduce(
      (best, current) => (current.points > best.points ? current : best),
      { grade: 'F', points: 0 }
    );

    const hasPassed = bestAttempt.points > 0;

    if (hasPassed) {
      totalWeightedPoints += bestAttempt.points * course.credits;
      totalCgpaCredits += course.credits;
    } else {
      // It is currently failed (no passing attempt)
      if (mode === 'regulation-formula') {
        // Under regulation-formula, failed courses are included in the divisor
        totalCgpaCredits += course.credits;
      }
      // Under annexure-backlog, failed courses are excluded
    }
  });

  if (totalCgpaCredits === 0) return null;
  return totalWeightedPoints / totalCgpaCredits;
}

function App() {
  const [selectedSchemeId, setSelectedSchemeId] = useState(schemes[0].id)
  const [cgpaMode, setCgpaMode] = useState<CgpaMode>('annexure-backlog')
  const [showManualEntry, setShowManualEntry] = useState(false)
  const [semesters, setSemesters] = useState<SemesterResult[]>([])
  const [status, setStatus] = useState('Paste marksheet text, select multiple PDFs/files, or enter results manually below.')

  // Track selection state (Scheme A or Scheme B)
  const [schemeTrack, setSchemeTrack] = useState<'A' | 'B'>('A')

  // Interactive manual entry form state
  const [manualSemNum, setManualSemNum] = useState<number>(1)
  const [manualSourceName, setManualSourceName] = useState<string>('Semester 1 Manual Entry')

  const selectedScheme = useMemo(
    () => schemes.find((scheme) => scheme.id === selectedSchemeId) ?? schemes[0],
    [selectedSchemeId],
  )

  const defaultGradeForSelectedScheme = useMemo(() => {
    return Object.keys(selectedScheme.gradePoints)[0] || 'O'
  }, [selectedScheme])

  const [manualCourses, setManualCourses] = useState<Array<{ code: string; name: string; credits: number; grade: string }>>([
    { code: '', name: '', credits: 3, grade: 'O' }
  ])

  // Initialize manual courses with correct grade when scheme changes
  useEffect(() => {
    setManualCourses((current) =>
      current.map((item) => ({
        ...item,
        grade: Object.keys(selectedScheme.gradePoints).includes(item.grade) ? item.grade : defaultGradeForSelectedScheme
      }))
    )
  }, [selectedScheme, defaultGradeForSelectedScheme])

  const processedSemesters = useMemo(() => {
    // Map each course code to all its attempts across semesters
    const subjectAttempts: Record<string, Array<{ semester: number; grade: string; points: number; sourceName: string }>> = {};
    
    semesters.forEach((sem) => {
      const semNum = sem.semester;
      if (semNum === null) return;
      sem.subjects.forEach((sub) => {
        const code = sub.code.toUpperCase().trim();
        const points = selectedScheme.gradePoints[sub.grade] ?? 0;
        if (!subjectAttempts[code]) {
          subjectAttempts[code] = [];
        }
        subjectAttempts[code].push({
          semester: semNum,
          grade: sub.grade,
          points,
          sourceName: sem.sourceName
        });
      });
    });

    return semesters.map((sem) => {
      if (sem.semester === null) {
        return {
          ...sem,
          recalculatedSgpa: null,
          recalculations: [],
          subjectsWithRecalc: sem.subjects.map(s => ({
            ...s,
            isRecalculated: false,
            recalculatedGrade: undefined,
            recalculatedPoints: undefined
          })) as RecalcSubjectRow[]
        };
      }

      const recalculations: Array<{ code: string; passedSem: number; grade: string; points: number }> = [];
      let recalculatedWeightedTotal = 0;
      let totalCredits = 0;

      const subjectsWithRecalc: RecalcSubjectRow[] = sem.subjects.map((sub) => {
        const code = sub.code.toUpperCase().trim();
        const originalPoints = selectedScheme.gradePoints[sub.grade] ?? 0;
        const isFailed = originalPoints === 0;

        totalCredits += sub.credits;

        if (isFailed) {
          const attempts = subjectAttempts[code] || [];
          const passingAttempt = attempts
            .filter((att) => att.semester > sem.semester! && att.points > 0)
            .sort((a, b) => a.semester - b.semester)[0]; // earliest pass

          if (passingAttempt) {
            recalculations.push({
              code: sub.code,
              passedSem: passingAttempt.semester,
              grade: passingAttempt.grade,
              points: passingAttempt.points
            });

            recalculatedWeightedTotal += passingAttempt.points * sub.credits;
            return {
              ...sub,
              isRecalculated: true,
              recalculatedGrade: passingAttempt.grade,
              recalculatedPoints: passingAttempt.points
            };
          }
        }

        recalculatedWeightedTotal += originalPoints * sub.credits;
        return {
          ...sub,
          isRecalculated: false,
          recalculatedGrade: undefined,
          recalculatedPoints: undefined
        };
      });

      const recalculatedSgpa = recalculations.length > 0 && totalCredits > 0
        ? recalculatedWeightedTotal / totalCredits
        : null;

      return {
        ...sem,
        recalculatedSgpa,
        recalculations,
        subjectsWithRecalc,
        recalculatedCreditPoints: recalculatedWeightedTotal
      };
    });
  }, [semesters, selectedScheme]);

  const cgpa = useMemo(() => calculateOverallCgpa(semesters, cgpaMode, selectedScheme), [semesters, cgpaMode, selectedScheme])

  const eligibility = useMemo(() => {
    const semNumbers = semesters.map((s) => s.semester).filter((num): num is number => num !== null)
    const hasSem1To4 = [1, 2, 3, 4].every((num) => semNumbers.includes(num))
    const hasSem1And2 = [1, 2].every((num) => semNumbers.includes(num))
    const sem1To4 = semesters.filter((s) => s.semester !== null && s.semester <= 4)

    // Scheme B Check
    let schemeBEligible = false
    const schemeBReasons: string[] = []

    if (!hasSem1To4) {
      schemeBReasons.push('Please import semesters 1, 2, 3, and 4 to check Scheme B eligibility.')
    } else {
      // 1. No backlog in Sem 1-4 (first attempt pass only)
      const hasBacklog = sem1To4.some((sem) =>
        sem.subjects.some((subj) => ['F', 'ABS', 'NE', 'DX', 'NP'].includes(subj.grade)),
      )
      if (hasBacklog) {
        schemeBReasons.push('Student has one or more failed/absent grades in Semester 1-4 (Scheme B requires first-attempt pass).')
      }

      // 2. CGPA >= 6.0 after Sem 4
      const cgpaAfterSem4 = calculateOverallCgpa(sem1To4, cgpaMode, selectedScheme)
      if (cgpaAfterSem4 === null) {
        schemeBReasons.push('Unable to calculate CGPA for Semesters 1-4.')
      } else if (cgpaAfterSem4 < 6.0) {
        schemeBReasons.push(`CGPA after Semester 4 is ${formatGpa(cgpaAfterSem4)} (must be 6.000 or above).`)
      }

      if (schemeBReasons.length === 0) {
        schemeBEligible = true
      }
    }

    // Scheme A Check
    let schemeAEligible = false
    const schemeAReasons: string[] = []

    if (!hasSem1And2) {
      schemeAReasons.push('Please import semesters 1 and 2 to check Scheme A eligibility.')
    } else {
      // All subjects of semesters 1 and 2 must be cleared
      const sem1And2Subjects = semesters
        .filter((s) => s.semester !== null && s.semester <= 2)
        .flatMap((s) => s.subjects)
      const uniqueCodes = Array.from(new Set(sem1And2Subjects.map((s) => s.code.toUpperCase())))
      const uncleared: string[] = []

      for (const code of uniqueCodes) {
        const attempts = semesters.flatMap((s) => s.subjects).filter((s) => s.code.toUpperCase() === code)
        const hasPassed = attempts.some((att) => {
          const gp = selectedScheme.gradePoints[att.grade]
          return typeof gp === 'number' && gp > 0
        })
        if (!hasPassed) {
          uncleared.push(code)
        }
      }

      if (uncleared.length > 0) {
        schemeAReasons.push(`The following Semester 1/2 courses are not yet cleared: ${uncleared.join(', ')}.`)
      } else {
        schemeAEligible = true
      }
    }

    return {
      schemeA: { eligible: schemeAEligible, reasons: schemeAReasons },
      schemeB: { eligible: schemeBEligible, reasons: schemeBReasons },
    }
  }, [semesters, cgpaMode, selectedScheme])

  function addManualCourseRow() {
    setManualCourses((current) => [
      ...current,
      { code: '', name: '', credits: 3, grade: defaultGradeForSelectedScheme }
    ])
  }

  function removeManualCourseRow(index: number) {
    setManualCourses((current) => {
      const updated = current.filter((_, idx) => idx !== index)
      return updated.length === 0 ? [{ code: '', name: '', credits: 3, grade: defaultGradeForSelectedScheme }] : updated
    })
  }

  function handleManualCourseChange(index: number, field: string, value: string | number) {
    setManualCourses((current) =>
      current.map((item, idx) => {
        if (idx !== index) return item
        return { ...item, [field]: value }
      })
    )
  }

  function saveManualSemester() {
    if (!manualSemNum || manualSemNum < 1 || manualSemNum > 10) {
      setStatus('Please enter a valid semester number (1 to 10).')
      return
    }

    const validCourses = manualCourses.filter((c) => c.code.trim() !== '')
    if (validCourses.length === 0) {
      setStatus('Please add at least one subject with a code.')
      return
    }

    const subjects: SubjectRow[] = validCourses.map((c) => ({
      code: c.code.toUpperCase().trim(),
      name: c.name.trim() || `Subject ${c.code.toUpperCase().trim()}`,
      credits: Number(c.credits) || 3,
      grade: c.grade.toUpperCase().trim(),
    }))

    const parsed: ParsedSemester = {
      semester: manualSemNum,
      schemeId: selectedSchemeId,
      sourceName: manualSourceName.trim() || `Semester ${manualSemNum} Manual Entry`,
      rawText: JSON.stringify(subjects),
      subjects,
    }

    const result = calculateSemesterResult(parsed, selectedScheme)

    setSemesters((current) => {
      const filtered = current.filter((item) => item.semester !== result.semester || item.semester === null)
      return [...filtered, result].sort((a, b) => (a.semester ?? 99) - (b.semester ?? 99))
    })

    setStatus(`Successfully manually added/updated Semester ${manualSemNum} with ${subjects.length} subjects.`)
    setShowManualEntry(false)

    // Reset manual form for next time
    setManualCourses([{ code: '', name: '', credits: 3, grade: defaultGradeForSelectedScheme }])
    setManualSemNum((prev) => (prev < 8 ? prev + 1 : 8))
    setManualSourceName(`Semester ${manualSemNum < 8 ? manualSemNum + 1 : 8} Manual Entry`)
  }

  function importText(sourceName: string, rawText: string) {
    const parsed = parseSemesterText(rawText, selectedScheme, sourceName)

    if (!parsed.subjects.length) {
      setStatus('No subjects were detected. Use CODE NAME CREDITS GRADE for pasted text, or upload an official VTU result PDF.')
      return
    }

    const result = calculateSemesterResult(parsed, selectedScheme)

    setSemesters((current) => {
      const filtered = current.filter((item) => item.semester !== result.semester || item.semester === null)
      return [...filtered, result].sort((a, b) => (a.semester ?? 99) - (b.semester ?? 99))
    })

    setStatus(`Imported ${result.subjects.length} subjects from ${sourceName}.`)
  }

  async function handleFileUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (!files.length) {
      return
    }

    try {
      setStatus(`Reading ${files.length} file(s)...`)

      for (const file of files) {
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          const pdfText = await pdfToText(file)
          importText(file.name, pdfText)
        } else {
          const rawText = await file.text()
          const cleanedText = file.name.toLowerCase().match(/\.html?$/) ? htmlToText(rawText) : rawText
          importText(file.name, cleanedText)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown parsing error'
      setStatus(`Could not finish import: ${message}`)
    } finally {
      event.target.value = ''
    }
  }

  return (
    <main className="app-shell">
      <div className="upload-note-banner">
        <span className="banner-icon">⚠️</span>
        <div className="banner-content">
          <strong>Important Upload Guide:</strong> Please make sure to upload <strong>all semester marksheets at once</strong>, including any backlog/makeup/backup exam marksheets. This ensures correct SGPA recalculation and accurate overall CGPA tracking.
        </div>
      </div>

      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">VTU SGPA / CGPA Helper</p>
          <h1>Build your VTU result calculator from marksheet text, HTML, or PDF output.</h1>
          <p className="lede">
            This utility parses semester subjects, applies the selected VTU grading scheme, 
            and tracks both SGPA and CGPA. It supports PDF uploads and manual entry.
          </p>
        </div>
        <div className="metric-grid">
          <article className="metric-card">
            <span>Semesters Saved</span>
            <strong>{semesters.length}</strong>
          </article>
          <article className="metric-card">
            <span>Current CGPA</span>
            <strong>{formatGpa(cgpa)}</strong>
          </article>
          <article className="metric-card">
            <span>Scheme</span>
            <strong>{selectedScheme.label}</strong>
          </article>
        </div>
      </section>

      <section className="workspace">
        <div className="panel">
          <div className="panel-head">
            <h2>Input Panel</h2>
            <p className="status-label">{status}</p>
          </div>

          <label className="field">
            <span>VTU Grading Scheme</span>
            <select value={selectedSchemeId} onChange={(event) => setSelectedSchemeId(event.target.value)}>
              {schemes.map((scheme) => (
                <option key={scheme.id} value={scheme.id}>
                  {scheme.label}
                </option>
              ))}
            </select>
            <small>{selectedScheme.description}</small>
          </label>

          <label className="field">
            <span>CGPA / Backlog Rule</span>
            <select value={cgpaMode} onChange={(event) => setCgpaMode(event.target.value as CgpaMode)}>
              <option value="annexure-backlog">Appendix I backlog example (cleared credits only)</option>
              <option value="regulation-formula">Regulation formula text (all registered credits)</option>
            </select>
            <small>
              {cgpaMode === 'annexure-backlog'
                ? 'Appendix I backlog mode: Omit failed course credits from the CGPA denominator until successfully cleared.'
                : 'Regulation formula mode: Use total registered credits (including failed courses) in the CGPA denominator.'}
            </small>
          </label>

          <div className="field">
            <span>Final Year Track Eligibility Tracker</span>
            <div className="track-selector">
              <button 
                type="button" 
                className={`track-tab-btn ${schemeTrack === 'A' ? 'active' : ''}`}
                onClick={() => setSchemeTrack('A')}
              >
                Scheme A (Regular Track)
              </button>
              <button 
                type="button" 
                className={`track-tab-btn ${schemeTrack === 'B' ? 'active' : ''}`}
                onClick={() => setSchemeTrack('B')}
              >
                Scheme B (One-Year Internship)
              </button>
            </div>
            
            <div className={`eligibility-status-box ${
              schemeTrack === 'A'
                ? (eligibility.schemeA.eligible ? 'eligible' : 'ineligible')
                : (eligibility.schemeB.eligible ? 'eligible' : 'ineligible')
            }`}>
              <div className="eligibility-status-head">
                <span className="status-indicator"></span>
                <strong>
                  {schemeTrack === 'A' ? 'Scheme A Status' : 'Scheme B Status'}:{' '}
                  {schemeTrack === 'A'
                    ? (eligibility.schemeA.eligible ? 'Eligible' : 'Not Eligible Yet')
                    : (eligibility.schemeB.eligible ? 'Eligible' : 'Not Eligible Yet')}
                </strong>
              </div>
              <ul className="eligibility-list">
                {schemeTrack === 'A' ? (
                  eligibility.schemeA.reasons.length > 0 ? (
                    eligibility.schemeA.reasons.map((reason, i) => <li key={i} className="requirement-failed">✗ {reason}</li>)
                  ) : (
                    <li className="requirement-passed">✓ All Semester 1 & 2 courses cleared. Ready for Scheme A.</li>
                  )
                ) : (
                  eligibility.schemeB.reasons.length > 0 ? (
                    eligibility.schemeB.reasons.map((reason, i) => <li key={i} className="requirement-failed">✗ {reason}</li>)
                  ) : (
                    <>
                      <li className="requirement-passed">✓ No backlogs in Semesters 1 to 4 (passed all on first attempt).</li>
                      <li className="requirement-passed">✓ CGPA is 6.00 or above at the time of admission to 5th semester.</li>
                    </>
                  )
                )}
              </ul>
              <small className="eligibility-footer-info">
                {schemeTrack === 'A'
                  ? 'Criteria: Students must clear all subjects from 1st and 2nd semesters.'
                  : 'Criteria: Stricter Nep-2020 track. Zero backlogs from 1st to 4th semesters (first attempt pass only) and CGPA ≥ 6.00.'}
              </small>
            </div>
          </div>

          <div className="actions">
            <button type="button" className="btn-primary" onClick={() => setShowManualEntry((current) => !current)}>
              {showManualEntry ? 'Close Manual Entry' : 'Enter manually'}
            </button>
            <label className="upload-button">
              Upload PDF / text files
              <input
                type="file"
                multiple
                accept=".txt,.html,.htm,.csv,.pdf,application/pdf"
                onChange={handleFileUpload}
              />
            </label>
          </div>

          {showManualEntry ? (
            <div className="manual-entry">
              <h3>Enter Semester Results Manually</h3>
              
              <div className="manual-entry-meta">
                <label className="field inline">
                  <span>Semester</span>
                  <select value={manualSemNum} onChange={(e) => {
                    const sem = Number(e.target.value);
                    setManualSemNum(sem);
                    setManualSourceName(`Semester ${sem} Manual Entry`);
                  }}>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
                      <option key={s} value={s}>
                        Semester {s}
                      </option>
                    ))}
                  </select>
                </label>
                
                <label className="field inline">
                  <span>Semester Label</span>
                  <input
                    type="text"
                    value={manualSourceName}
                    onChange={(e) => setManualSourceName(e.target.value)}
                    placeholder="e.g. Semester 3"
                  />
                </label>
              </div>

              <div className="manual-entry-table-wrapper">
                <table className="manual-entry-table">
                  <thead>
                    <tr>
                      <th>Course Code *</th>
                      <th>Course Name</th>
                      <th>Credits *</th>
                      <th>Grade *</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {manualCourses.map((course, index) => (
                      <tr key={index}>
                        <td>
                          <input
                            type="text"
                            value={course.code}
                            onChange={(e) => handleManualCourseChange(index, 'code', e.target.value)}
                            placeholder="e.g. 22CS31"
                            className="code-input"
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={course.name}
                            onChange={(e) => handleManualCourseChange(index, 'name', e.target.value)}
                            placeholder="Data Structures"
                            className="name-input"
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            value={course.credits}
                            onChange={(e) => handleManualCourseChange(index, 'credits', Math.max(1, Number(e.target.value) || 1))}
                            min="1"
                            max="10"
                            className="credits-input"
                          />
                        </td>
                        <td>
                          <select
                            value={Object.keys(selectedScheme.gradePoints).includes(course.grade) ? course.grade : defaultGradeForSelectedScheme}
                            onChange={(e) => handleManualCourseChange(index, 'grade', e.target.value)}
                            className="grade-select"
                          >
                            {Object.keys(selectedScheme.gradePoints).map((g) => (
                              <option key={g} value={g}>
                                {g}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="delete-row-btn"
                            onClick={() => removeManualCourseRow(index)}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="manual-entry-actions">
                <button type="button" className="add-row-btn" onClick={addManualCourseRow}>
                  + Add Subject Row
                </button>
                <div className="manual-entry-submit-group">
                  <button type="button" className="btn-cancel" onClick={() => setShowManualEntry(false)}>
                    Cancel
                  </button>
                  <button type="button" className="btn-save" onClick={saveManualSemester}>
                    Save Semester
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="rules-box">
            <h3>How SGPA and CGPA are Calculated</h3>
            
            <div className="formula-section">
              <h4>1. Semester Grade Point Average (SGPA)</h4>
              <div className="formula-display">
                SGPA = Σ (Ci × Gi) / Σ Ci
              </div>
              <p>
                Where <strong>Ci</strong> represents the course credits and <strong>Gi</strong> represents the grade points secured by the student in that course.
              </p>
              <p className="backlog-note-text">
                <strong>Backlog Rules in SGPA:</strong> Under the VTU 2022 CBCS regulations, courses with failed grades (F/ABS) are still included in the SGPA denominator (credits registered) in the semester they are attempted. Once re-registered and cleared, they contribute to the SGPA of the semester in which they are successfully cleared.
              </p>
            </div>

            <div className="formula-section">
              <h4>2. Cumulative Grade Point Average (CGPA)</h4>
              <div className="formula-display">
                CGPA = Σ (Ci × Si) / Σ Ci
              </div>
              <p>
                Where <strong>Si</strong> represents the SGPA of semester <strong>i</strong> and <strong>Ci</strong> represents the total credits considered for that semester.
              </p>
              <p>
                <strong>Calculation Method Selector:</strong>
              </p>
              <ul>
                <li>
                  <strong>Appendix I (Backlog-Exclusion) Mode:</strong> Under the Appendix I backlog worked example, F-grade credits are temporarily excluded from the CGPA denominator until cleared. This prevents failed courses from lowering the CGPA divisor before they are passed.
                </li>
                <li>
                  <strong>Regulation Formula Mode:</strong> Strictly follows the general formula text using all registered credits in the divisor, including failed ones.
                </li>
              </ul>
            </div>

            <div className="formula-section">
              <h4>3. Active Grading Scale ({selectedScheme.label})</h4>
              <div className="table-responsive">
                <table className="mini-table">
                  <thead>
                    <tr>
                      <th>Grade</th>
                      {Object.keys(selectedScheme.gradePoints).map((g) => (
                        <th key={g}>{g}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Points</td>
                      {Object.values(selectedScheme.gradePoints).map((pt, i) => (
                        <td key={i}>{pt}</td>
                      ))}
                    </tr>
                    {selectedScheme.markRanges && (
                      <tr>
                        <td>Marks</td>
                        {selectedScheme.markRanges.map((range, i) => (
                          <td key={i}>{range.min}%+</td>
                        ))}
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="formula-section">
              <h4>4. Credit Allocation Rules (PDF Upload)</h4>
              <p>When you upload official VTU result sheets, course credits are inferred automatically based on the following pattern rules:</p>
              <ul>
                <li>Laboratory / Practical Courses: <strong>1 Credit</strong></li>
                <li>Project Work / Phase: <strong>2 Credits</strong></li>
                <li>Constitution, Intellectual Property, PE, or IKS: <strong>1 Credit</strong></li>
                <li>All Professional Core / Theory Courses: <strong>3 Credits</strong></li>
              </ul>
            </div>
          </div>

          <div className="hint-box">
            <h3>Usage Instructions</h3>
            <p>You can upload multiple VTU marksheets or PDF files at once. All semester SGPAs and overall CGPAs will update automatically.</p>
            <p>For PDFs, the app parses the layout structure and infers grades and credits. You can inspect each semester's subjects in the right panel.</p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Semesters</h2>
            <p>Each imported semester contributes automatically to CGPA.</p>
          </div>

          {processedSemesters.length === 0 ? (
            <div className="empty-state">No semesters imported yet.</div>
          ) : (
            <div className="semester-stack">
              {processedSemesters.map((result, index) => (
                <article key={`${result.sourceName}-${index}`} className="semester-card">
                  <div className="semester-head">
                    <div>
                      <p className="semester-tag">Semester {result.semester ?? 'Unknown'}</p>
                      <h3>{result.sourceName}</h3>
                    </div>
                    {result.recalculatedSgpa !== null ? (
                      <div className="sgpa-pill-group">
                        <span className="sgpa-pill original strikes">SGPA {formatGpa(result.sgpa)}</span>
                        <span className="sgpa-pill recalculated">Recalculated: {formatGpa(result.recalculatedSgpa)}</span>
                      </div>
                    ) : (
                      <div className="sgpa-pill">SGPA {formatGpa(result.sgpa)}</div>
                    )}
                  </div>

                  <div className="calc-summary">
                    <span>Total credits: {result.totalCredits}</span>
                    <span>Earned credits: {result.earnedCredits}</span>
                    <span>CGPA credits used: {cgpaMode === 'annexure-backlog' ? result.cgpaCredits : result.totalCredits}</span>
                    <span>Method: sum(credit x grade point) / {result.totalCredits || '--'}</span>
                  </div>

                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr>
                          <th>Code</th>
                          <th>Subject</th>
                          <th>Total</th>
                          <th>Credits</th>
                          <th>Grade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.subjectsWithRecalc.map((subject) => (
                          <tr key={subject.code} className={subject.isRecalculated ? 'recalculated-row' : ''}>
                            <td>{subject.code}</td>
                            <td>{subject.name}</td>
                            <td>{subject.total ?? '--'}</td>
                            <td>{subject.credits}</td>
                            <td className="grade-cell">
                              {subject.isRecalculated ? (
                                <>
                                  <span className="original-grade strikes">{subject.grade}</span>
                                  <span className="arrow-sep"> ➔ </span>
                                  <span className="new-grade">{subject.recalculatedGrade}</span>
                                </>
                              ) : (
                                subject.grade
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {result.recalculations.length > 0 && (
                    <div className="recalc-comments-box">
                      {result.recalculations.map((recalc) => (
                        <div key={recalc.code} className="recalc-comment">
                          💡 <strong>{recalc.code}</strong> recalculated based on you passed it in {recalc.passedSem}{getOrdinalSuffix(recalc.passedSem)} sem
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>

      {cgpa !== null && (
        <div className="floating-cgpa-bar">
          <div className="floating-cgpa-content">
            <span className="floating-cgpa-label">Overall CGPA</span>
            <strong className="floating-cgpa-val">{formatGpa(cgpa)}</strong>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
