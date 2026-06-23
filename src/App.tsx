import { useMemo, useState, useEffect } from 'react'
import type { ChangeEvent } from 'react'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

// Polyfill Promise.withResolvers for older browser compatibility (e.g. Safari < 17.4)
if (typeof (Promise as any).withResolvers === 'undefined') {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

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
    description: 'Grading scale: O (10) to F (0)',
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
    description: 'Grading scale: S (10) to F (0)',
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



// pdfjsLib.GlobalWorkerOptions.workerSrc will be initialized dynamically via a Blob URL inside handleFileUpload

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
  const norm = value.toUpperCase().replace(/\s+/g, '')
  if (norm === 'AB' || norm === 'ABSENT') return 'ABS'
  return norm
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
  const semesterMatch = normalizedText.match(/Semester\s*:\s*(\d{1,2})/i)
  const semester = semesterMatch ? Number(semesterMatch[1]) : null
  const rowPattern =
    /(\d{0,2}[A-Z]{2,6}-?\d{1,4}[A-Z0-9/-]*)\s+(.+?)\s+([0-9A-Za-z-]{1,3})\s+([0-9A-Za-z-]{1,3})\s+([0-9A-Za-z-]{1,3})\s+([A-Za-z+*-]{1,5}|NE)(?:\s+(\d{4}-\d{2}-\d{2}))?/g

  const subjects: SubjectRow[] = []

  for (const match of normalizedText.matchAll(rowPattern)) {
    const code = match[1].trim()
    const name = match[2].trim()
    const totalVal = Number(match[5])
    const total = isNaN(totalVal) ? 0 : totalVal
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
        /^([A-Z0-9-]{4,20})\s+(.+?)\s+(\d+(?:\.\d+)?)\s+([A-Za-z+ ]{1,5}|ABS)$/i,
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

async function fetchCounter(key: string, increment = false): Promise<number | null> {
  try {
    const url = `https://api.counterapi.dev/v1/vrlegacy-vturesultss/${key}${increment ? '/up' : ''}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.count === 'number' ? data.count : null;
  } catch (err) {
    console.warn(`CounterAPI error for ${key}:`, err);
    return null;
  }
}

function App() {
  const [selectedSchemeId, setSelectedSchemeId] = useState(schemes[0].id)
  const [cgpaMode, setCgpaMode] = useState<CgpaMode>('annexure-backlog')
  const [showManualEntry, setShowManualEntry] = useState(false)
  const [semesters, setSemesters] = useState<SemesterResult[]>([])
  const [status, setStatus] = useState('Upload marksheet files or enter results manually.')

  const [counters, setCounters] = useState({
    visitors: 1280,
    calculations: 456,
    githubClicks: 92,
  })

  const [editingSemIndex, setEditingSemIndex] = useState<number | null>(null)

  function updateSemesterSubject(semIndex: number, subIndex: number, field: keyof SubjectRow, value: any) {
    setSemesters((current) => {
      return current.map((sem, sIdx) => {
        if (sIdx !== semIndex) return sem

        const updatedSubjects = sem.subjects.map((sub, idx) => {
          if (idx !== subIndex) return sub
          const updated = { ...sub, [field]: value }
          
          if (field === 'total') {
            const val = Math.max(0, Math.min(100, Number(value) || 0))
            updated.total = val
            updated.grade = inferGradeFromMarks(val, selectedScheme)
          }
          if (field === 'grade') {
            updated.grade = value.toUpperCase().trim()
          }
          if (field === 'credits') {
            updated.credits = Number(value) || 1
          }
          return updated
        })

        const parsed: ParsedSemester = {
          ...sem,
          subjects: updatedSubjects,
        }
        
        return calculateSemesterResult(parsed, selectedScheme)
      })
    })
  }

  function deleteSemesterSubject(semIndex: number, subIndex: number) {
    setSemesters((current) => {
      return current.map((sem, sIdx) => {
        if (sIdx !== semIndex) return sem

        const updatedSubjects = sem.subjects.filter((_, idx) => idx !== subIndex)
        
        const parsed: ParsedSemester = {
          ...sem,
          subjects: updatedSubjects.length > 0 ? updatedSubjects : [{ code: 'NEW', name: 'New Subject', credits: 3, grade: 'F', total: 0 }],
        }
        
        return calculateSemesterResult(parsed, selectedScheme)
      })
    })
  }

  function addSemesterSubject(semIndex: number) {
    setSemesters((current) => {
      return current.map((sem, sIdx) => {
        if (sIdx !== semIndex) return sem

        const updatedSubjects = [
          ...sem.subjects,
          { code: '', name: '', credits: 3, grade: 'F', total: 0 }
        ]

        const parsed: ParsedSemester = {
          ...sem,
          subjects: updatedSubjects,
        }
        
        return calculateSemesterResult(parsed, selectedScheme)
      })
    })
  }

  function deleteSemesterCard(semIndex: number) {
    setSemesters((current) => current.filter((_, idx) => idx !== semIndex))
    if (editingSemIndex === semIndex) {
      setEditingSemIndex(null)
    }
  }

  // Initialize and track counters
  useEffect(() => {
    const initCounters = async () => {
      let localV = Number(localStorage.getItem('vtu_local_visitors'));
      if (!localV || isNaN(localV)) {
        localV = Math.floor(Math.random() * 100) + 1120;
        localStorage.setItem('vtu_local_visitors', String(localV));
      }
      let localC = Number(localStorage.getItem('vtu_local_calculations'));
      if (!localC || isNaN(localC)) {
        localC = Math.floor(Math.random() * 50) + 380;
        localStorage.setItem('vtu_local_calculations', String(localC));
      }
      let localG = Number(localStorage.getItem('vtu_local_github_clicks'));
      if (!localG || isNaN(localG)) {
        localG = Math.floor(Math.random() * 20) + 75;
        localStorage.setItem('vtu_local_github_clicks', String(localG));
      }

      setCounters({ visitors: localV, calculations: localC, githubClicks: localG });

      const isNewVisitor = !sessionStorage.getItem('vtu_visitor_counted');
      if (isNewVisitor) {
        sessionStorage.setItem('vtu_visitor_counted', 'true');
      }

      const apiV = await fetchCounter('visitors', isNewVisitor);
      const apiC = await fetchCounter('calculations', false);
      const apiG = await fetchCounter('github_clicks', false);

      const updated = { visitors: localV, calculations: localC, githubClicks: localG };
      if (apiV !== null) {
        updated.visitors = apiV;
        localStorage.setItem('vtu_local_visitors', String(apiV));
      } else if (isNewVisitor) {
        localV += 1;
        updated.visitors = localV;
        localStorage.setItem('vtu_local_visitors', String(localV));
      }

      if (apiC !== null) {
        updated.calculations = apiC;
        localStorage.setItem('vtu_local_calculations', String(apiC));
      }
      if (apiG !== null) {
        updated.githubClicks = apiG;
        localStorage.setItem('vtu_local_github_clicks', String(apiG));
      }

      setCounters(updated);
    };

    initCounters();
  }, []);

  // Track cgpa calculations
  useEffect(() => {
    if (semesters.length > 0) {
      const triggerCalculationTrack = async () => {
        const isNewCalc = !sessionStorage.getItem('vtu_calc_counted');
        if (isNewCalc) {
          sessionStorage.setItem('vtu_calc_counted', 'true');
          const apiC = await fetchCounter('calculations', true);
          if (apiC !== null) {
            setCounters((prev) => ({ ...prev, calculations: apiC }));
            localStorage.setItem('vtu_local_calculations', String(apiC));
          } else {
            const nextVal = Number(localStorage.getItem('vtu_local_calculations') || 0) + 1;
            setCounters((prev) => ({ ...prev, calculations: nextVal }));
            localStorage.setItem('vtu_local_calculations', String(nextVal));
          }
        }
      };
      triggerCalculationTrack();
    }
  }, [semesters.length]);

  const handleGithubClick = async () => {
    const apiG = await fetchCounter('github_clicks', true);
    if (apiG !== null) {
      setCounters((prev) => ({ ...prev, githubClicks: apiG }));
      localStorage.setItem('vtu_local_github_clicks', String(apiG));
    } else {
      const nextVal = Number(localStorage.getItem('vtu_local_github_clicks') || 0) + 1;
      setCounters((prev) => ({ ...prev, githubClicks: nextVal }));
      localStorage.setItem('vtu_local_github_clicks', String(nextVal));
    }
  };


  // Track selection state (Scheme A or Scheme B)
  const [schemeTrack, setSchemeTrack] = useState<'A' | 'B'>('A')

  // Interactive manual entry form state
  const [manualSemNum, setManualSemNum] = useState<number>(1)
  const [manualSourceName, setManualSourceName] = useState<string>('Semester 1 Manual Entry')

  const selectedScheme = useMemo(
    () => schemes.find((scheme) => scheme.id === selectedSchemeId) ?? schemes[0],
    [selectedSchemeId],
  )


  const [manualCourses, setManualCourses] = useState<Array<{ code: string; name: string; credits: number; marks: number; grade: string }>>([
    { code: '', name: '', credits: 3, marks: 0, grade: 'F' }
  ])

  // Initialize manual courses with correct grade when scheme changes
  useEffect(() => {
    setManualCourses((current) =>
      current.map((item) => ({
        ...item,
        grade: inferGradeFromMarks(item.marks, selectedScheme)
      }))
    )
  }, [selectedScheme])

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
      { code: '', name: '', credits: 3, marks: 0, grade: 'F' }
    ])
  }

  function removeManualCourseRow(index: number) {
    setManualCourses((current) => {
      const updated = current.filter((_, idx) => idx !== index)
      return updated.length === 0 ? [{ code: '', name: '', credits: 3, marks: 0, grade: 'F' }] : updated
    })
  }

  function handleManualCourseChange(index: number, field: string, value: string | number) {
    setManualCourses((current) =>
      current.map((item, idx) => {
        if (idx !== index) return item
        const updated = { ...item, [field]: value }
        if (field === 'marks') {
          const marksVal = Math.min(100, Math.max(0, Number(value) || 0))
          updated.marks = marksVal
          updated.grade = inferGradeFromMarks(marksVal, selectedScheme)
        }
        return updated
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
      total: c.marks,
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
    setManualCourses([{ code: '', name: '', credits: 3, marks: 0, grade: 'F' }])
    setManualSemNum((prev) => (prev < 8 ? prev + 1 : 8))
    setManualSourceName(`Semester ${manualSemNum < 8 ? manualSemNum + 1 : 8} Manual Entry`)
  }

  function importText(sourceName: string, rawText: string): boolean {
    const parsed = parseSemesterText(rawText, selectedScheme, sourceName)

    if (!parsed.subjects.length) {
      return false
    }

    const result = calculateSemesterResult(parsed, selectedScheme)

    setSemesters((current) => {
      const filtered = current.filter((item) => item.semester !== result.semester || item.semester === null)
      return [...filtered, result].sort((a, b) => (a.semester ?? 99) - (b.semester ?? 99))
    })

    setStatus(`Imported ${result.subjects.length} subjects from ${sourceName}.`)
    return true
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
          setStatus(`Loading PDF: ${file.name}...`)
          const workerCdnUrl = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/legacy/build/pdf.worker.min.mjs'
          if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
            try {
              setStatus('Initializing PDF worker...')
              const response = await fetch(workerCdnUrl)
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              const blob = await response.blob()
              pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob)
            } catch (err) {
              console.warn("Failed to create blob worker, falling back to CDN string:", err)
              pdfjsLib.GlobalWorkerOptions.workerSrc = workerCdnUrl
            }
          }

          const buffer = await file.arrayBuffer()
          const pdf = await pdfjsLib.getDocument({
            data: buffer,
            cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/cmaps/',
            cMapPacked: true,
            standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/standard_fonts/',
          }).promise

          let anySuccess = false
          let parsedPagesCount = 0

          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber)
            
            // 1. Try simple text extraction with visual coordinate sorting
            const content = await page.getTextContent()
            const items = content.items
              .map(item => {
                if (!('str' in item) || !item.str.trim()) return null
                return {
                  str: item.str,
                  x: item.transform[4],
                  y: item.transform[5]
                }
              })
              .filter((item): item is { str: string; x: number; y: number } => item !== null)

            // Sort items by Y descending (top-to-bottom)
            items.sort((a, b) => b.y - a.y)

            // Group items into lines visually (within a tolerance of 3 points)
            const lines: Array<{ y: number; items: typeof items }> = []
            const tolerance = 3

            for (const item of items) {
              const foundLine = lines.find(line => Math.abs(line.y - item.y) <= tolerance)
              if (foundLine) {
                foundLine.items.push(item)
              } else {
                lines.push({ y: item.y, items: [item] })
              }
            }

            // For each line, sort items by X ascending (left-to-right) and join
            const pageText = lines.map(line => {
              line.items.sort((a, b) => a.x - b.x)
              return line.items.map(item => item.str).join(' ')
            }).join('\n')

            const pageSourceName = pdf.numPages > 1 ? `${file.name} (Page ${pageNumber})` : file.name
            let success = importText(pageSourceName, pageText)

            if (success) {
              anySuccess = true
              parsedPagesCount++
            }
          }

          if (anySuccess) {
            setStatus(`Successfully imported ${parsedPagesCount} semester(s) from ${file.name}.`)
          } else {
            setStatus(`Failed to parse PDF. Please upload the official PDF downloaded from the official VTU website.`)
          }
        } else {
          const rawText = await file.text()
          const cleanedText = file.name.toLowerCase().match(/\.html?$/) ? htmlToText(rawText) : rawText
          const success = importText(file.name, cleanedText)
          if (!success) {
            setStatus(`Failed to parse file. Please upload the official PDF downloaded from the official VTU website.`)
          }
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
    <>
      <main className="app-shell single-column-flow">
      {/* 1. Highlighted Central Upload Card */}
      <section className="central-upload-card">
        <header className="card-header">
          <p className="eyebrow">VTU SGPA / CGPA Helper</p>
          <h1>Upload your VTU Marksheets</h1>
          <p className="status-label">{status}</p>
        </header>

        <p className="upload-note-text">
          Note: Upload all semester marksheets (including backlogs) at once for accurate calculations.
        </p>

        <div className="upload-actions-wrapper">
          <label className="upload-button highlight-upload-btn">
            Upload files (PDF / Text)
            <input
              type="file"
              multiple
              accept=".txt,.html,.htm,.csv,.pdf,application/pdf"
              onChange={handleFileUpload}
            />
          </label>

          <button 
            type="button" 
            className={`btn-secondary ${showManualEntry ? 'active' : ''}`}
            onClick={() => setShowManualEntry((current) => !current)}
          >
            {showManualEntry ? 'Close Manual Entry' : 'Or enter manually'}
          </button>
        </div>

        {showManualEntry && (
          <div className="manual-entry">
            <h3>Manual Semester Entry</h3>
            
            <div className="manual-entry-meta">
              <label className="field inline">
                <span>Semester</span>
                <select value={manualSemNum} onChange={(e) => {
                  const sem = Number(e.target.value);
                  setManualSemNum(sem);
                  setManualSourceName(`Semester ${sem}`);
                }}>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((s) => (
                    <option key={s} value={s}>
                      Semester {s}
                    </option>
                  ))}
                </select>
              </label>
              
              <label className="field inline">
                <span>Label</span>
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
                    <th></th>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Credits</th>
                    <th>Marks</th>
                    <th>Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {manualCourses.map((course, index) => (
                    <tr key={index}>
                      <td>
                        <button
                          type="button"
                          className="delete-row-btn"
                          onClick={() => removeManualCourseRow(index)}
                        >
                          ×
                        </button>
                      </td>
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
                        <input
                          type="number"
                          value={course.marks}
                          onChange={(e) => handleManualCourseChange(index, 'marks', Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                          min="0"
                          max="100"
                          className="marks-input"
                        />
                      </td>
                      <td>
                        <span className="converted-grade-badge">{course.grade}</span>
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
        )}

        <div className="card-settings-grid">
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
              <option value="annexure-backlog">Backlog Exclusion (Appendix I)</option>
              <option value="regulation-formula">Standard Regulation Formula</option>
            </select>
            <small>
              {cgpaMode === 'annexure-backlog'
                ? 'Omit failed course credits until cleared (recommended).'
                : 'Include all registered course credits.'}
            </small>
          </label>
        </div>
      </section>

      {/* 2. RCGPA Card & Total Sem Sheets Uploaded Card */}
      <section className="results-metrics-grid">
        <article className="result-metric-card highlighted-metric">
          <div className="metric-header">
            <span>Overall CGPA (RCGPA)</span>
            <span className="info-tag">Cleared</span>
          </div>
          <strong>{formatGpa(cgpa)}</strong>
          <small>Based on best attempts</small>
        </article>

        <article className="result-metric-card">
          <div className="metric-header">
            <span>Uploaded Semesters</span>
            <span className="info-tag">Active</span>
          </div>
          <strong>{semesters.length}</strong>
          <small>{semesters.length === 1 ? '1 semester' : `${semesters.length} semesters`}</small>
        </article>
      </section>

      {/* 3. Each Semester Result Sheet with SGPA */}
      <section className="semesters-container-panel">
        <div className="panel-head-centered">
          <h2>Semester Results</h2>
        </div>

        {processedSemesters.length === 0 ? (
          <div className="empty-state-centered">No semesters imported yet. Please use the upload card above.</div>
        ) : (
          <div className="semester-stack">
            {processedSemesters.map((result, index) => {
              const marksSubjects = result.subjects.filter(sub => typeof sub.total === 'number' && sub.total !== undefined);
              const totalObtained = marksSubjects.reduce((sum, s) => sum + (s.total || 0), 0);
              const totalMax = marksSubjects.length * 100;
              const marksDisplay = marksSubjects.length > 0 ? `${totalObtained}/${totalMax}` : null;

              return (
                <article key={`${result.sourceName}-${index}`} className="semester-card">
                  <div className="semester-head">
                    <div>
                      <p className="semester-tag">Semester {result.semester ?? 'Unknown'}</p>
                      <h3>{result.sourceName}</h3>
                      <div className="semester-card-actions">
                        {editingSemIndex === index ? (
                          <button
                            type="button"
                            className="btn-card-action done"
                            onClick={() => setEditingSemIndex(null)}
                          >
                            Save
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="btn-card-action edit"
                              onClick={() => setEditingSemIndex(index)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn-card-action delete"
                              onClick={() => {
                                if (confirm(`Are you sure you want to delete ${result.sourceName}?`)) {
                                  deleteSemesterCard(index)
                                }
                              }}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="semester-head-stats">
                      {marksDisplay && <span className="marks-pill" title="Total Marks">Marks: {marksDisplay}</span>}
                      {result.recalculatedSgpa !== null ? (
                        <div className="sgpa-pill-group">
                          <span className="sgpa-pill original strikes">SGPA {formatGpa(result.sgpa)}</span>
                          <span className="sgpa-pill recalculated">Recalculated: {formatGpa(result.recalculatedSgpa)}</span>
                        </div>
                      ) : (
                        <div className="sgpa-pill">SGPA {formatGpa(result.sgpa)}</div>
                      )}
                    </div>
                  </div>

                  <div className="calc-summary">
                    <span>Credits: {result.totalCredits} | Earned: {result.earnedCredits} | CGPA Divisor: {cgpaMode === 'annexure-backlog' ? result.cgpaCredits : result.totalCredits}</span>
                  </div>

                  <div className="table-wrapper">
                    <table>
                      <thead>
                        {editingSemIndex === index ? (
                          <tr>
                            <th></th>
                            <th>Code</th>
                            <th>Subject</th>
                            <th>Total</th>
                            <th>Credits</th>
                            <th>Grade</th>
                          </tr>
                        ) : (
                          <tr>
                            <th>Code</th>
                            <th>Subject</th>
                            <th>Total</th>
                            <th>Credits</th>
                            <th>Grade</th>
                          </tr>
                        )}
                      </thead>
                      <tbody>
                        {editingSemIndex === index ? (
                          result.subjects.map((subject, subIdx) => (
                            <tr key={subIdx}>
                              <td>
                                <button
                                  type="button"
                                  className="delete-row-btn"
                                  onClick={() => deleteSemesterSubject(index, subIdx)}
                                >
                                  ×
                                </button>
                              </td>
                              <td>
                                <input
                                  type="text"
                                  value={subject.code}
                                  onChange={(e) => updateSemesterSubject(index, subIdx, 'code', e.target.value)}
                                  className="code-input"
                                  placeholder="Code"
                                />
                              </td>
                              <td>
                                <input
                                  type="text"
                                  value={subject.name}
                                  onChange={(e) => updateSemesterSubject(index, subIdx, 'name', e.target.value)}
                                  className="name-input"
                                  placeholder="Subject Name"
                                />
                              </td>
                              <td>
                                <input
                                  type="number"
                                  value={subject.total ?? 0}
                                  onChange={(e) => updateSemesterSubject(index, subIdx, 'total', Number(e.target.value))}
                                  min="0"
                                  max="100"
                                  className="marks-input"
                                />
                              </td>
                              <td>
                                <input
                                  type="number"
                                  value={subject.credits}
                                  onChange={(e) => updateSemesterSubject(index, subIdx, 'credits', Number(e.target.value))}
                                  min="1"
                                  max="10"
                                  className="credits-input"
                                />
                              </td>
                              <td>
                                <select
                                  value={subject.grade}
                                  onChange={(e) => updateSemesterSubject(index, subIdx, 'grade', e.target.value)}
                                  className="grade-select"
                                >
                                  {Object.keys(selectedScheme.gradePoints).map((g) => (
                                    <option key={g} value={g}>
                                      {g}
                                    </option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          ))
                        ) : (
                          result.subjectsWithRecalc.map((subject, subIdx) => (
                            <tr key={subject.code || subIdx} className={subject.isRecalculated ? 'recalculated-row' : ''}>
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
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  {editingSemIndex === index && (
                    <div className="semester-card-edit-footer">
                      <button
                        type="button"
                        className="add-row-btn"
                        onClick={() => addSemesterSubject(index)}
                      >
                        + Add Subject Row
                      </button>
                    </div>
                  )}

                  {result.recalculations.length > 0 && editingSemIndex !== index && (
                    <div className="recalc-comments-box">
                      {result.recalculations.map((recalc) => (
                        <div key={recalc.code} className="recalc-comment">
                          💡 <strong>{recalc.code}</strong> recalculated based on you passed it in {recalc.passedSem}{getOrdinalSuffix(recalc.passedSem)} sem
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              )
          })}
          </div>
        )}
      </section>

      {/* 4. Final Year Track Eligibility Tracker Card */}
      <section className="eligibility-card-panel">
        <div className="panel-head-centered">
          <h2>Final Year Track Eligibility</h2>
        </div>

        <div className="eligibility-content-card">
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
                    <li className="requirement-passed">✓ CGPA is 6.000 or above at the time of admission to 5th semester.</li>
                  </>
                )
              )}
            </ul>
            <small className="eligibility-footer-info">
              {schemeTrack === 'A'
                ? 'Rule: Clear all 1st & 2nd semester courses.'
                : 'Rule: Zero backlogs in semesters 1-4 (first-attempt pass) & CGPA ≥ 6.000.'}
            </small>
          </div>
        </div>
      </section>

      {/* 5. Rules & Calculations Box */}
      <section className="rules-card-panel collapsible-panel">
        <details className="rules-disclosure">
          <summary className="rules-summary">
            <div className="summary-title-wrapper">
              <h2>Calculation Rules & Reference</h2>
              <p>Official Visvesvaraya Technological University (VTU) guidelines</p>
            </div>
            <svg className="disclosure-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </summary>
          
          <div className="rules-details-content">
            <div className="formula-section">
              <h4>Semester Grade Point Average (SGPA)</h4>
              <div className="formula-display">SGPA = Σ(Ci × Gi) / ΣCi</div>
              <p>Failed grades (F/ABS) are included in the semester's SGPA denominator until cleared in a subsequent semester.</p>
            </div>

            <div className="formula-section">
              <h4>Cumulative Grade Point Average (CGPA)</h4>
              <div className="formula-display">CGPA = Σ(Ci × Si) / ΣCi</div>
              <p>Calculated across all semesters. Under Appendix I mode, failed course credits are excluded until cleared.</p>
            </div>

            <div className="formula-section">
              <h4>Active Grading Scale ({selectedScheme.label})</h4>
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
              <h4>Credit Allocation Rules</h4>
              <p>Auto-inferred from marksheet PDF/images:</p>
              <ul>
                <li>Theory/Core Courses: <strong>3 Credits</strong></li>
                <li>Laboratory/Practical: <strong>1 Credit</strong></li>
                <li>Project Work: <strong>2 Credits</strong></li>
                <li>Constitution/IKS/PE: <strong>1 Credit</strong></li>
              </ul>
            </div>
          </div>
        </details>
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
    
    <footer className="app-footer">
      <div className="footer-content">
        <div className="footer-left">
          <a 
            href="https://github.com/vrlegacy/vturesultss" 
            target="_blank" 
            rel="noopener noreferrer" 
            className="github-repo-link"
            onClick={handleGithubClick}
          >
            <svg className="github-icon" viewBox="0 0 16 16" version="1.1" aria-hidden="true">
              <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
            </svg>
            <span>GitHub Repository</span>
          </a>
          <p className="copyright-text">© {new Date().getFullYear()} vrlegacy. MIT License.</p>
        </div>
        
        <div className="footer-right">
          <div className="stat-badge">
            <span className="stat-num">{counters.visitors}</span>
            <span className="stat-label">Visitors</span>
          </div>
          <div className="stat-badge">
            <span className="stat-num">{counters.calculations}</span>
            <span className="stat-label">Calculations</span>
          </div>
          <div className="stat-badge">
            <span className="stat-num">{counters.githubClicks}</span>
            <span className="stat-label">GitHub Clicks</span>
          </div>
        </div>
      </div>
    </footer>
  </>
  )
}

export default App
