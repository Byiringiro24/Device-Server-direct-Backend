import type { Request, Response } from "express";
import { parsePagination } from "../helpers/pagination";
import { successResponse } from "../helpers/response";
import { AppError } from "../middleware/errorHandler";
import * as studentService from "../services/student.service";
import { Gender } from "@prisma/client";
import { getAssignedDormitoryIds } from "../services/boarding/supervisor.service";

const boardingSupervisorScope = async (req: Request) => {
  const effectiveRoles = [
    req.user?.role,
    ...(Array.isArray(req.user?.secondary_roles) ? req.user.secondary_roles : []),
  ].filter((role): role is string => typeof role === "string");
  const requestedRole = String(req.header("x-active-role") ?? "").trim().toLowerCase();
  // Multi-role accounts retain all of their assigned permissions, but student
  // roster scoping must follow the workspace the user selected. Otherwise a
  // teacher who is also a patron/matron would see only the dormitory/gender
  // slice while marking classroom attendance.
  const activeRole = requestedRole && effectiveRoles.includes(requestedRole)
    ? requestedRole
    : req.user?.role;
  if (activeRole !== "patron" && activeRole !== "matron") return {};

  const boardingRole = activeRole;

  return {
    dormitory_ids: await getAssignedDormitoryIds(req.user!.school_id!, req.user!.id),
    gender: boardingRole === "patron" ? Gender.male : Gender.female,
  };
};

const resolveSchoolId = (req: Request) => {
  const schoolId = req.user?.school_id;
  if (!schoolId) {
    throw new AppError("forbidden", "Missing school context", 403);
  }

  return schoolId;
};

export const createStudent = async (req: Request, res: Response) => {
  const schoolId = resolveSchoolId(req);
  const student = await studentService.createStudent(schoolId, req.body);
  res.status(201).json(successResponse(student));
};

export const listStudents = async (req: Request, res: Response) => {
  const schoolId = resolveSchoolId(req);
  const pagination = parsePagination(req.query as Record<string, string>);
  const scope = await boardingSupervisorScope(req);
  const filters = {
    status: req.query.status as string | undefined,
    student_type: req.query.student_type as string | undefined,
    include_deleted: req.query.include_deleted as boolean | undefined,
    section_id: req.query.section_id as string | undefined,
    student_school_id: req.query.student_school_id as string | undefined,
    ...scope,
  };

  const result = await studentService.findAllStudents(schoolId, pagination, filters);
  res.json(successResponse(result.data, result.meta));
};

export const getStudent = async (req: Request, res: Response) => {
  const schoolId = resolveSchoolId(req);
  const student = await studentService.getStudentWithDetails(
    schoolId,
    req.params.id,
    await boardingSupervisorScope(req),
  );
  res.json(successResponse(student));
};

export const updateStudent = async (req: Request, res: Response) => {
  const schoolId = resolveSchoolId(req);
  const student = await studentService.updateStudent(schoolId, req.params.id, req.body);
  res.json(successResponse(student));
};

export const updateVisitorAccess = async (req: Request, res: Response) => {
  const schoolId = resolveSchoolId(req);
  const student = await studentService.updateVisitorAccess(schoolId, req.params.id, req.body.blocked);
  res.json(successResponse(student));
};

export const deleteStudent = async (req: Request, res: Response) => {
  const schoolId = resolveSchoolId(req);
  const student = await studentService.softDeleteStudent(schoolId, req.params.id);
  res.json(successResponse(student));
};

export const importStudentsFromCsv = async (req: Request, res: Response) => {
  const schoolId = resolveSchoolId(req);
  if (!req.file) {
    throw new AppError("bad_request", "CSV file is required", 400);
  }

  const sectionId = req.query.section_id as string | undefined;
  const academicYearId = req.query.academic_year_id as string | undefined;
  const termId = req.query.term_id as string | undefined;

  if ((sectionId && !academicYearId) || (!sectionId && academicYearId)) {
    throw new AppError(
      "bad_request",
      "section_id and academic_year_id must be provided together",
      400
    );
  }

  const enrollment =
    sectionId && academicYearId
      ? { section_id: sectionId, academic_year_id: academicYearId, term_id: termId }
      : undefined;

  const result = await studentService.bulkImportFromCSV(
    schoolId,
    req.file,
    enrollment
  );
  res.status(201).json(successResponse(result));
};

export const createStudentEnrollment = async (req: Request, res: Response) => {
  const schoolId = resolveSchoolId(req);
  const enrollment = await studentService.createStudentEnrollment(
    schoolId,
    req.params.id,
    req.body
  );
  res.status(201).json(successResponse(enrollment));
};

export const listStudentEnrollments = async (req: Request, res: Response) => {
  const schoolId = resolveSchoolId(req);
  const pagination = parsePagination(req.query as Record<string, string>);
  const filters = {
    status: req.query.status as string | undefined,
    academic_year_id: req.query.academic_year_id as string | undefined
  };

  const result = await studentService.listStudentEnrollments(
    schoolId,
    req.params.id,
    pagination,
    filters
  );
  res.json(successResponse(result.data, result.meta));
};

export const uploadStudentPhoto = async (req: Request, res: Response) => {
  const schoolId = resolveSchoolId(req);
  if (!req.file) {
    throw new AppError("bad_request", "Photo file is required", 400);
  }

  const photoUrl = `uploads/${req.file.filename}`;
  const student = await studentService.updateStudent(schoolId, req.params.id, {
    photo_url: photoUrl
  });
  res.json(successResponse(student));
};
