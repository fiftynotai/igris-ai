/// A project registered in the Igris brain.
class ProjectModel {
  final String slug;
  final String name;
  final String path;
  final String? techStack;
  final String status;

  const ProjectModel({
    required this.slug,
    required this.name,
    required this.path,
    this.techStack,
    required this.status,
  });

  factory ProjectModel.fromJson(Map<String, dynamic> json) => ProjectModel(
        slug: json['slug'] as String? ?? '',
        name: json['name'] as String? ?? json['slug'] as String? ?? '',
        path: json['path'] as String? ?? '',
        techStack: json['tech_stack'] as String?,
        status: json['status'] as String? ?? 'active',
      );

  Map<String, dynamic> toJson() => {
        'slug': slug,
        'name': name,
        'path': path,
        'tech_stack': techStack,
        'status': status,
      };
}
